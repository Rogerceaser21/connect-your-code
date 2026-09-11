import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  composeObjects,
  deleteObject,
  downloadObject,
  getGcsAccessToken,
  listChunkCount,
  listObjectNames,
  uploadToGcs,
  type ServiceAccount,
} from "../_shared/gcs.ts";
import {
  deleteGeminiFile,
  generateSummary,
  transcribeSegment,
  uploadToGeminiFileAPI,
  waitForGeminiFileActive,
} from "../_shared/gemini.ts";
import {
  buildSegmentPrompt,
  chunkObjectName,
  countMissingSegments,
  findInitBoundary,
  findLeadBoundary,
  firstMissingSegment,
  formatHMS,
  hexHead,
  initObjectName,
  isWebm,
  joinTranscript,
  leadObjectName,
  leaseIsValid,
  planSegments,
  scrubSecrets,
  segmentObjectName,
  segmentStartSeconds,
  segmentsPrefix,
  type SegmentsState,
} from "../_shared/segments.ts";

/**
 * SEGMENT WORKER.
 *
 * One request transcribes AS MANY ~10 minute segments as fit inside BUDGET_MS,
 * persisting after each one, then kicks a fresh request for the rest and
 * returns. The kick is fire-and-forget (aborted 1.5 s after it is sent): the
 * callee keeps running after its caller disconnects — the same behaviour the
 * client already relies on (see triggerTranscription in src/pages/Meetings.tsx:
 * its invoke times out while the server finishes). Nothing awaits the rest of
 * the chain, so no worker is held alive by its successors and no segment
 * inherits the first worker's wall clock.
 *
 * Body: { meetingId, retry? }. Every other field is ignored (old clients still
 * send geminiFileUri / gcsBucket / … — harmless).
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SEGMENT_CHUNKS = 20;      // 20 x 30 s chunks = 10 min of audio per Gemini call
const LEASE_MS = 180_000;       // a worker owns the segment it is on for 3 min
const BUDGET_MS = 100_000;      // stop STARTING segments after this much wall clock
const FILE_ACTIVE_CAP_MS = 60_000;
const MAX_SEGMENT_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 5_000; // x attempt number, retry path only
const KICK_ABORT_MS = 1_500;    // how long we stay connected to the next worker
const PREV_TAIL_CHARS = 600;    // how much of segment i-1 the prompt quotes

// Which isolate served this request. Two requests logging the same INSTANCE
// landed on the SAME worker (a warm isolate); different values prove the kick
// really started a fresh one.
const INSTANCE = crypto.randomUUID().slice(0, 8);

// @ts-ignore — EdgeRuntime is provided by the Supabase edge runtime
declare const EdgeRuntime: { waitUntil: (p: Promise<unknown>) => void };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Wake the watchdog. Fire-and-forget: the poller's own chain keeps ticking
 * every 60 s after this, and it is what rescues a chain whose worker died
 * mid-segment (Gemini timeout, isolate eviction, an early throw). Nothing here
 * is awaited beyond the delivery of the request, and every error is swallowed:
 * the poller is a safety net, never a dependency of the work in flight.
 */
function armPoller(supabaseUrl: string, serviceKey: string, chainCount = 0) {
  const pollerUrl = `${supabaseUrl}/functions/v1/focusos-poll-stuck-meetings`;
  try {
    // waitUntil so the POST survives this request returning; the abort keeps us
    // from waiting for the poller's whole tick.
    EdgeRuntime.waitUntil((async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), KICK_ABORT_MS);
      try {
        await fetch(pollerUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
            apikey: serviceKey,
          },
          body: JSON.stringify({ chainCount }),
          signal: controller.signal,
        });
      } catch (e) {
        const name = (e as { name?: string })?.name ?? String(e);
        console.log(`[segment ${INSTANCE}] armPoller released (${name})`);
      } finally {
        clearTimeout(timer);
      }
    })());
  } catch (e) {
    console.warn(`[segment ${INSTANCE}] armPoller threw:`, e);
  }
}

/**
 * Hand the baton to a fresh worker and let go of it. The fetch is aborted
 * KICK_ABORT_MS after it starts — long enough for the request to be delivered,
 * short enough that this worker never waits for the work it just handed over.
 * delayMs is used only on the failure path, so a transient Gemini error does
 * not burn all three attempts within a couple of seconds.
 */
function kickSelf(
  supabaseUrl: string,
  serviceKey: string,
  meetingId: string,
  delayMs = 0
) {
  const selfUrl = `${supabaseUrl}/functions/v1/focusos-transcribe-meeting`;
  // Every handover also re-arms the watchdog: if this kick is the one that gets
  // lost, the poller resumes the chain instead of the meeting hanging.
  armPoller(supabaseUrl, serviceKey, 0);
  try {
    EdgeRuntime.waitUntil((async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), KICK_ABORT_MS);
      try {
        // Bounded by the abort above: this never waits for the segments the
        // next worker is about to do, only for the request to be delivered.
        await fetch(selfUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
            apikey: serviceKey,
          },
          body: JSON.stringify({ meetingId }),
          signal: controller.signal,
        });
      } catch (e) {
        // AbortError is the EXPECTED outcome, not a failure: the next worker
        // keeps running without us.
        const name = (e as { name?: string })?.name ?? String(e);
        console.log(`[segment ${INSTANCE}] kickSelf released (${name})`);
      } finally {
        clearTimeout(timer);
      }
    })());
  } catch (e) {
    console.warn(`[segment ${INSTANCE}] kickSelf threw:`, e);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const requestStart = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  let meetingId = "";
  let segmentIndex: number | null = null;
  let state: SegmentsState | null = null;
  const processed: number[] = [];

  /** Re-read transcript_segments and merge a patch into it, WITHOUT writing. */
  const mergeRead = async (patch: Partial<SegmentsState>): Promise<SegmentsState> => {
    const { data: fresh } = await supabase
      .from("focusos_meetings")
      .select("transcript_segments")
      .eq("id", meetingId)
      .maybeSingle();
    const current = ((fresh as any)?.transcript_segments ?? state) as SegmentsState;
    return {
      ...current,
      ...patch,
      texts: { ...(current?.texts ?? {}), ...(patch.texts ?? {}) },
      attempts: { ...(current?.attempts ?? {}), ...(patch.attempts ?? {}) },
    };
  };

  /**
   * Merge + write, but ONLY while the row is still 'transcribing'. A write that
   * touches no row is LOGGED, never thrown: it means the meeting moved on under
   * us (a retry re-opened it, the poller failed it, another worker finalized)
   * and this worker is about to stand down anyway.
   */
  const mergeState = async (patch: Partial<SegmentsState>): Promise<SegmentsState> => {
    const merged = await mergeRead(patch);
    const { data, error } = await supabase
      .from("focusos_meetings")
      .update({ transcript_segments: merged })
      .eq("id", meetingId)
      .eq("processing_status", "transcribing")
      .select("id");
    if (error) {
      console.warn(`[segment ${INSTANCE}] ${meetingId}: state write error — ${error.message}`);
    } else if (!data || data.length === 0) {
      console.log(
        `[segment ${INSTANCE}] ${meetingId}: state write affected 0 rows ` +
        `(no longer 'transcribing')`
      );
    }
    state = merged;
    return merged;
  };

  /**
   * Take the lease on segment i in ONE conditional UPDATE and check what it
   * affected. This is the whole concurrency story: three things can invoke this
   * worker (the client, the poller, a kick), so "read the row, see no lease,
   * write a lease" is a lost-update race the moment a segment runs past
   * LEASE_MS. The filter re-evaluates the lease AT WRITE TIME inside Postgres,
   * so exactly one of N racing workers gets a row back; everyone else backs off.
   *
   *   id = meetingId
   *   AND processing_status = 'transcribing'
   *   AND ( transcript_segments->>'lease' IS NULL            -- key missing OR json null
   *         OR transcript_segments->'lease'->>'until' IS NULL
   *         OR transcript_segments->'lease'->>'until' < now )
   *
   * `->>` (not `->`) on the lease key is deliberate: after a finalize or a
   * release the key holds JSON null, and `(jsonb->'lease') IS NULL` is FALSE for
   * that, while `(jsonb->>'lease') IS NULL` is TRUE for both a missing key and a
   * JSON null. `until` is always written as new Date().toISOString(), so the
   * text comparison against nowIso is chronological.
   */
  const takeLease = async (i: number): Promise<boolean> => {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const merged = await mergeRead({
      lease: { segment: i, until: new Date(now + LEASE_MS).toISOString() },
    });
    const { data, error } = await supabase
      .from("focusos_meetings")
      .update({ transcript_segments: merged })
      .eq("id", meetingId)
      .eq("processing_status", "transcribing")
      .or(
        "transcript_segments->>lease.is.null," +
        "transcript_segments->lease->>until.is.null," +
        `transcript_segments->lease->>until.lt.${nowIso}`
      )
      .select("id");
    if (error) throw new Error(`Lease update failed: ${error.message}`);
    if (!data || data.length === 0) return false;
    state = merged;
    return true;
  };

  /** The live processing_status, re-read from the row (null when it is gone). */
  const liveStatus = async (): Promise<string | null> => {
    const { data } = await supabase
      .from("focusos_meetings")
      .select("processing_status")
      .eq("id", meetingId)
      .maybeSingle();
    return ((data as any)?.processing_status ?? null) as string | null;
  };

  try {
    /* ─── a. Read the row ──────────────────────────────────────── */
    const body = await req.json().catch(() => ({}));
    meetingId = (body as any)?.meetingId ?? "";
    const isRetry = (body as any)?.retry === true;
    if (!meetingId) return json({ error: "Missing meetingId" }, 400);
    console.log(
      `[segment ${INSTANCE}] start meeting=${meetingId} retry=${isRetry} ` +
      `budget=${Math.round(BUDGET_MS / 1000)}s lease=${Math.round(LEASE_MS / 1000)}s`
    );

    const { data: row, error: rowErr } = await supabase
      .from("focusos_meetings")
      .select(
        "id, user_id, title, participants, duration_seconds, recording_gcs_path, processing_status, transcript_segments, gemini_transcribe_attempts"
      )
      .eq("id", meetingId)
      .maybeSingle();

    if (rowErr) throw new Error(`Cannot read meeting: ${rowErr.message}`);
    if (!row) throw new Error("Meeting not found");

    const meeting = row as any;
    const hadSegments = meeting.transcript_segments != null;
    // A retry is only ever a re-open of a FAILED meeting.
    const isReopen = isRetry && meeting.processing_status === "error";

    if (meeting.processing_status !== "transcribing") {
      // A retry re-opens a FAILED meeting; anything else (done, summarizing)
      // is left exactly as it is.
      if (!isReopen) {
        console.log(`[segment ${INSTANCE}] ${meetingId} is '${meeting.processing_status}' — nothing to do`);
        return json({ skipped: meeting.processing_status });
      }
      await supabase
        .from("focusos_meetings")
        .update({ processing_status: "transcribing", processing_error: null })
        .eq("id", meetingId);
      console.log(`[segment ${INSTANCE}] ${meetingId}: retry re-opened an errored meeting`);
    } else if (isRetry) {
      // A retry on a LIVE run must NOT clear the lease: that is how two workers
      // end up on the same segment. The run in flight keeps its lease; if it is
      // really dead, the poller resumes it once the lease expires.
      console.log(`[segment ${INSTANCE}] ${meetingId}: retry ignored — already transcribing`);
      armPoller(supabaseUrl, serviceKey, 0);
      return json({ busy: true });
    }

    // Observability only: nothing gates on this counter any more.
    await supabase
      .from("focusos_meetings")
      .update({
        gemini_transcribe_attempts: (meeting.gemini_transcribe_attempts ?? 0) + 1,
        gemini_transcribe_started_at: new Date().toISOString(),
      })
      .eq("id", meetingId);

    /* ─── b. Locate the recording + plan the segments ──────────── */
    const pathMatch = String(meeting.recording_gcs_path || "").match(
      /^gs:\/\/([^/]+)\/(.+)\/recording\./
    );
    if (!pathMatch) {
      throw new Error(`Cannot parse recording_gcs_path: ${meeting.recording_gcs_path}`);
    }
    const bucket = pathMatch[1];
    const folder = pathMatch[2];

    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
    if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");
    const gcsKeyJson = Deno.env.get("GCS_SERVICE_ACCOUNT_JSON");
    if (!gcsKeyJson) throw new Error("GCS_SERVICE_ACCOUNT_JSON not configured");
    const sa: ServiceAccount = JSON.parse(gcsKeyJson);
    const gcsToken = await getGcsAccessToken(sa);

    // WebM only, and PROVEN below from chunk 00000's EBML magic. focusos_meetings
    // has no mime_type column (the read that used to be here was always
    // undefined) and the init / lead-cluster search is WebM-specific.
    const mimeType = "audio/webm";

    state = (meeting.transcript_segments ?? null) as SegmentsState | null;
    if (!state || typeof state.total !== "number") {
      // No plan yet (a fresh meeting, or a retry of a row whose
      // transcript_segments is null): plan from scratch.
      const chunkCount = await listChunkCount(gcsToken, bucket, folder);
      if (chunkCount === 0) throw new Error("No chunks found in the recording folder");
      const plans = planSegments(chunkCount, SEGMENT_CHUNKS);
      state = {
        total: plans.length,
        chunkCount,
        segmentChunks: SEGMENT_CHUNKS,
        initReady: false,
        texts: {},
        attempts: {},
        // A retry starts the resume budget over; otherwise preserve the count
        // the poller may already have written.
        resumes: isRetry ? 0 : ((meeting.transcript_segments as any)?.resumes ?? 0),
        lease: null,
      };
      await supabase
        .from("focusos_meetings")
        .update({ transcript_segments: state })
        .eq("id", meetingId);
      console.log(`[segment ${INSTANCE}] ${meetingId}: ${chunkCount} chunks -> ${plans.length} segments`);
    } else if (isReopen && hadSegments) {
      /* ─── D. RETRY ─────────────────────────────────────────────
       * Keep the texts and the plan, drop everything that stops work:
       * the failure attempts, the poller's resume budget, and any lease
       * (a retry deliberately pre-empts a worker that went quiet).      */
      state = { ...state, attempts: {}, resumes: 0, lease: null };
      await supabase
        .from("focusos_meetings")
        .update({ transcript_segments: state, processing_error: null })
        .eq("id", meetingId);
      console.log(
        `[segment ${INSTANCE}] ${meetingId}: retry — attempts/lease/resumes cleared, ` +
        `${countMissingSegments(state.texts, state.total)}/${state.total} segment(s) still missing`
      );
    }

    // The plan is durable now, so the watchdog can resume this meeting on its
    // own from here: arm it BEFORE the first (expensive) Gemini call. Nothing
    // else in the server path does this — the client's list read is not a
    // watchdog, it does not happen while a user watches the spinner.
    armPoller(supabaseUrl, serviceKey, 0);

    /* ─── c. Lease check (cheap pre-check only) ────────────────────
     * The AUTHORITY is takeLease()'s conditional UPDATE below; this read just
     * saves a round trip when the answer is obviously "someone else is on it". */
    if (leaseIsValid(state.lease, Date.now())) {
      console.log(`[segment ${INSTANCE}] ${meetingId}: segment ${state.lease?.segment} already leased`);
      return json({ busy: true });
    }

    /* ─── d. Transcribe ONE segment ────────────────────────────── */
    const runSegment = async (i: number) => {
      const total = state!.total;
      // The lease on segment i is ALREADY held: the caller took it with
      // takeLease(i) (one conditional UPDATE), which is the only safe way to
      // claim it when three different callers can start this worker.

      const plan = planSegments(state!.chunkCount, state!.segmentChunks)[i];
      if (!plan) throw new Error(`No plan for segment ${i} of ${total}`);

      // Segment 0 needs nothing prepended: chunk 00000 carries the EBML header
      // and starts on a Cluster. Every later segment needs the header, plus the
      // head of the Cluster that the chunk boundary cut in half.
      const sources: string[] = [];
      if (i > 0) {
        const initObject = initObjectName(folder);
        if (!state!.initReady) {
          const chunkZero = await downloadObject(gcsToken, bucket, chunkObjectName(folder, 0));
          // FAIL FAST on a non-WebM recording: browsers without MediaRecorder
          // WebM support fall back to audio/mp4, which has no EBML header and no
          // Clusters at all, so every boundary search below is meaningless. A
          // readable cause on the card beats "WebM init boundary not found".
          if (!isWebm(chunkZero)) {
            throw new Error(
              `Recording is not WebM (first bytes ${hexHead(chunkZero)}); ` +
              "segmented transcription supports WebM only"
            );
          }
          const boundary = findInitBoundary(chunkZero);
          await uploadToGcs(gcsToken, bucket, initObject, chunkZero.slice(0, boundary), mimeType);
          console.log(`[segment ${INSTANCE}] ${meetingId}: init.webm written (${boundary} bytes)`);
          await mergeState({ initReady: true });
        }
        sources.push(initObject);

        try {
          const prevIndex = plan.firstChunk - 1;
          const prevChunk = await downloadObject(gcsToken, bucket, chunkObjectName(folder, prevIndex));
          const leadStart = findLeadBoundary(prevChunk);
          const leadObject = leadObjectName(folder, i);
          await uploadToGcs(gcsToken, bucket, leadObject, prevChunk.slice(leadStart), mimeType);
          sources.push(leadObject);
          console.log(
            `[segment ${INSTANCE}] ${meetingId}: segment ${i} lead = ${prevChunk.length - leadStart} bytes ` +
            `from chunk ${prevIndex} (offset ${leadStart}/${prevChunk.length})`
          );
        } catch (leadErr) {
          // No usable lead cluster: compose without it. Costs at most one
          // cluster of audio at the seam, never the segment.
          const message = leadErr instanceof Error ? leadErr.message : String(leadErr);
          console.warn(`[segment ${INSTANCE}] ${meetingId}: segment ${i} has no lead cluster — ${message}`);
        }
      }
      for (let k = plan.firstChunk; k <= plan.lastChunk; k++) {
        sources.push(chunkObjectName(folder, k));
      }

      const segmentObject = segmentObjectName(folder, i);
      await composeObjects(gcsToken, bucket, sources, segmentObject, mimeType);
      console.log(
        `[segment ${INSTANCE}] ${meetingId}: composed segment ${i + 1}/${total} ` +
        `(chunks ${plan.firstChunk}-${plan.lastChunk}, ${sources.length} sources)`
      );

      const fileUri = await uploadToGeminiFileAPI(
        GEMINI_API_KEY,
        gcsToken,
        bucket,
        segmentObject,
        mimeType,
        `${meeting.title || "meeting"} part ${i + 1}`
      );
      await waitForGeminiFileActive(GEMINI_API_KEY, fileUri, FILE_ACTIVE_CAP_MS);

      const participantNames = (meeting.participants || [])
        .filter((p: any) => p?.name?.trim())
        .map((p: any) => p.name.trim());
      const previousTail = i > 0
        ? (state!.texts[String(i - 1)] || "").slice(-PREV_TAIL_CHARS)
        : "";
      const prompt = buildSegmentPrompt(
        i,
        total,
        formatHMS(segmentStartSeconds(i, state!.segmentChunks)),
        participantNames,
        previousTail
      );

      const text = await transcribeSegment(GEMINI_API_KEY, fileUri, mimeType, prompt);
      console.log(`[segment ${INSTANCE}] ${meetingId}: segment ${i + 1}/${total} -> ${text.length} chars`);

      // Persist BEFORE anything else can go wrong: this segment is now paid for.
      await mergeState({ texts: { [String(i)]: text }, lease: null });

      try {
        await deleteGeminiFile(GEMINI_API_KEY, fileUri);
      } catch (e) {
        console.warn(`[segment ${INSTANCE}] Gemini file delete failed (non-critical):`, e);
      }
    };

    /* ─── e. Drop init.webm + segments/ once the transcript is safe ─ */
    const cleanupSegmentArtifacts = async () => {
      try {
        const names = await listObjectNames(gcsToken, bucket, segmentsPrefix(folder));
        const targets = [initObjectName(folder), ...names];
        let deleted = 0;
        for (const name of targets) {
          try {
            await deleteObject(gcsToken, bucket, name);
            deleted++;
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            console.warn(`[segment ${INSTANCE}] cleanup: ${name} not deleted — ${message}`);
          }
        }
        // recording.webm and chunks/ stay: playback and any re-run need them.
        console.log(`[segment ${INSTANCE}] ${meetingId}: cleanup deleted ${deleted}/${targets.length} object(s)`);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn(`[segment ${INSTANCE}] ${meetingId}: cleanup failed (non-critical) — ${message}`);
      }
    };

    try {
      /* ─── C. Budgeted loop: as many segments as fit in this request ── */
      while (true) {
        // The row can move out from under us between segments (a retry failed
        // it, the poller gave up, another worker finished it). Re-read, and stop
        // the moment this is no longer OUR job.
        const status = await liveStatus();
        if (status !== "transcribing") {
          console.log(
            `[segment ${INSTANCE}] ${meetingId}: status is now '${status}' — standing down ` +
            `after ${processed.length} segment(s)`
          );
          return json({ processed, stopped: status ?? "missing" });
        }

        const next = firstMissingSegment(state.texts, state.total);
        if (next === null) break;
        const elapsed = Date.now() - requestStart;
        if (elapsed >= BUDGET_MS) {
          console.log(
            `[segment ${INSTANCE}] ${meetingId}: budget spent (${Math.round(elapsed / 1000)}s, ` +
            `${processed.length} segment(s) this request) — handing over at segment ${next}`
          );
          break;
        }
        // ONE conditional UPDATE decides who owns this segment.
        if (!(await takeLease(next))) {
          console.log(
            `[segment ${INSTANCE}] ${meetingId}: segment ${next} was leased by another ` +
            `worker — standing down after ${processed.length} segment(s)`
          );
          return json({ processed, busy: true });
        }
        segmentIndex = next;
        await runSegment(next);
        processed.push(next);
        segmentIndex = null;
      }

      const remaining = countMissingSegments(state.texts, state.total);
      if (remaining > 0) {
        // kickSelf re-arms the watchdog itself.
        kickSelf(supabaseUrl, serviceKey, meetingId);
        return json({ processed, remaining });
      }

      /* ─── f. FINALIZE ────────────────────────────────────────── */
      const transcript = joinTranscript(state.texts, state.total, state.segmentChunks);
      if (!transcript.trim()) throw new Error("Joined transcript is empty");

      const transcriptGcsPath = await uploadToGcs(
        gcsToken,
        bucket,
        `${folder}/transcript.json`,
        JSON.stringify({ transcript, timestamp: new Date().toISOString() }),
        "application/json"
      );

      const summary = await generateSummary(
        GEMINI_API_KEY,
        transcript,
        "concise",
        meeting.duration_seconds || 0
      );

      // Drop the per-segment texts once the transcript is durable in GCS:
      // the meetings list prefetch does select('*'), so an 80 KB transcript
      // left in this jsonb would ride along on every app load.
      const finalState: SegmentsState = {
        ...state,
        texts: {},
        lease: null,
      };

      const { data: finalized, error: updateError } = await supabase
        .from("focusos_meetings")
        .update({
          summary,
          transcript_gcs_path: transcriptGcsPath,
          processing_status: "done",
          processing_error: null,
          gemini_file_uri: null,
          transcription_text: null,
          transcript_segments: finalState,
        })
        .eq("id", meetingId)
        // Only the worker that still sees 'transcribing' finalizes: two of them
        // must never both flip the row to done.
        .eq("processing_status", "transcribing")
        .select("id");
      if (updateError) throw new Error(`Failed to update meeting: ${updateError.message}`);
      if (!finalized || finalized.length === 0) {
        console.log(`[segment ${INSTANCE}] ${meetingId}: already finalized elsewhere — leaving it`);
        return json({ processed, skipped: "already finalized" });
      }

      console.log(`[segment ${INSTANCE}] ${meetingId}: finalized ${state.total} segments`);
      await cleanupSegmentArtifacts();
      return json({ done: true, total: state.total });
    } catch (workErr) {
      /* ─── g. Segment / finalize failure ────────────────────── */
      // scrubSecrets FIRST: a Deno fetch failure quotes the request URL, and
      // every Gemini URL carries ?key=<GEMINI_API_KEY>. This string is persisted
      // to processing_error and shown on the meeting card.
      const message = scrubSecrets(workErr, [serviceKey, Deno.env.get("GEMINI_API_KEY")]) ||
        "Unknown error";
      const key = segmentIndex === null ? "final" : String(segmentIndex);
      const label = segmentIndex === null
        ? "Finalize"
        : `Segment ${segmentIndex + 1}/${state?.total ?? 0}`;
      console.error(`[segment ${INSTANCE}] ${meetingId}: ${label} failed —`, message);

      const attemptCount = ((state?.attempts ?? {})[key] ?? 0) + 1;
      await mergeState({ attempts: { [key]: attemptCount }, lease: null });
      await supabase
        .from("focusos_meetings")
        .update({ processing_error: `${label}: ${message}` })
        .eq("id", meetingId)
        // Never stamp an error on a row another worker already finished.
        .eq("processing_status", "transcribing");

      if (attemptCount < MAX_SEGMENT_ATTEMPTS) {
        kickSelf(supabaseUrl, serviceKey, meetingId, attemptCount * RETRY_BACKOFF_MS);
        return json({ processed, retry: segmentIndex ?? "final", attempt: attemptCount });
      }

      await supabase
        .from("focusos_meetings")
        .update({ processing_status: "error" })
        .eq("id", meetingId)
        .eq("processing_status", "transcribing");
      return json({ processed, failed: segmentIndex ?? "final", attempt: attemptCount });
    }
  } catch (error) {
    const message = scrubSecrets(
      error instanceof Error ? error.message : (error ?? "Unknown error"),
      [serviceKey, Deno.env.get("GEMINI_API_KEY")]
    ) || "Unknown error";
    console.error(`[segment ${INSTANCE}] handler error:`, message);
    if (meetingId) {
      try {
        await supabase
          .from("focusos_meetings")
          .update({ processing_error: message })
          .eq("id", meetingId);
      } catch (dbErr) {
        console.error(`[segment ${INSTANCE}] failed to record handler error:`, dbErr);
      }
      // Whatever just went wrong, the row is still 'transcribing': let the
      // watchdog decide whether to resume it or fail it for good.
      armPoller(supabaseUrl, serviceKey, 0);
    }
    return json({ error: message }, 400);
  }
});
