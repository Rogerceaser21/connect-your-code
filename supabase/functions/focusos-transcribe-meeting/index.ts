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
  initObjectName,
  joinTranscript,
  leadObjectName,
  leaseIsValid,
  planSegments,
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

// @ts-ignore — EdgeRuntime is provided by the Supabase edge runtime
declare const EdgeRuntime: { waitUntil: (p: Promise<unknown>) => void };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
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
        console.log(`[segment] kickSelf released (${name})`);
      } finally {
        clearTimeout(timer);
      }
    })());
  } catch (e) {
    console.warn("[segment] kickSelf threw:", e);
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

  /** Re-read transcript_segments and merge, so a concurrent write is not clobbered. */
  const mergeState = async (patch: Partial<SegmentsState>): Promise<SegmentsState> => {
    const { data: fresh } = await supabase
      .from("focusos_meetings")
      .select("transcript_segments")
      .eq("id", meetingId)
      .maybeSingle();
    const current = ((fresh as any)?.transcript_segments ?? state) as SegmentsState;
    const merged: SegmentsState = {
      ...current,
      ...patch,
      texts: { ...(current?.texts ?? {}), ...(patch.texts ?? {}) },
      attempts: { ...(current?.attempts ?? {}), ...(patch.attempts ?? {}) },
    };
    await supabase
      .from("focusos_meetings")
      .update({ transcript_segments: merged })
      .eq("id", meetingId);
    state = merged;
    return merged;
  };

  try {
    /* ─── a. Read the row ──────────────────────────────────────── */
    const body = await req.json().catch(() => ({}));
    meetingId = (body as any)?.meetingId ?? "";
    const isRetry = (body as any)?.retry === true;
    if (!meetingId) return json({ error: "Missing meetingId" }, 400);

    const { data: row, error: rowErr } = await supabase
      .from("focusos_meetings")
      .select(
        "id, user_id, title, participants, duration_seconds, recording_gcs_path, processing_status, transcript_segments, gemini_transcribe_attempts"
      )
      .eq("id", meetingId)
      .maybeSingle();

    if (rowErr) return json({ error: rowErr.message }, 400);
    if (!row) return json({ error: "Meeting not found" }, 400);

    const meeting = row as any;
    const hadSegments = meeting.transcript_segments != null;

    if (meeting.processing_status !== "transcribing") {
      // A retry re-opens a FAILED meeting; anything else (done, summarizing)
      // is left exactly as it is.
      if (!(isRetry && meeting.processing_status === "error")) {
        console.log(`[segment] ${meetingId} is '${meeting.processing_status}' — nothing to do`);
        return json({ skipped: meeting.processing_status });
      }
      await supabase
        .from("focusos_meetings")
        .update({ processing_status: "transcribing", processing_error: null })
        .eq("id", meetingId);
      console.log(`[segment] ${meetingId}: retry re-opened an errored meeting`);
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
      return json({ error: `Cannot parse recording_gcs_path: ${meeting.recording_gcs_path}` }, 400);
    }
    const bucket = pathMatch[1];
    const folder = pathMatch[2];

    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
    if (!GEMINI_API_KEY) return json({ error: "GEMINI_API_KEY not configured" }, 400);
    const gcsKeyJson = Deno.env.get("GCS_SERVICE_ACCOUNT_JSON");
    if (!gcsKeyJson) return json({ error: "GCS_SERVICE_ACCOUNT_JSON not configured" }, 400);
    const sa: ServiceAccount = JSON.parse(gcsKeyJson);
    const gcsToken = await getGcsAccessToken(sa);

    const mimeType = (meeting as any).mime_type || "audio/webm";

    state = (meeting.transcript_segments ?? null) as SegmentsState | null;
    if (!state || typeof state.total !== "number") {
      // No plan yet (a fresh meeting, or a retry of a row whose
      // transcript_segments is null): plan from scratch.
      const chunkCount = await listChunkCount(gcsToken, bucket, folder);
      if (chunkCount === 0) return json({ error: "No chunks found" }, 400);
      const plans = planSegments(chunkCount, SEGMENT_CHUNKS);
      state = {
        total: plans.length,
        chunkCount,
        segmentChunks: SEGMENT_CHUNKS,
        initReady: false,
        texts: {},
        attempts: {},
        // preserve a resume count the poller may already have written
        resumes: (meeting.transcript_segments as any)?.resumes ?? 0,
        lease: null,
      };
      await supabase
        .from("focusos_meetings")
        .update({ transcript_segments: state })
        .eq("id", meetingId);
      console.log(`[segment] ${meetingId}: ${chunkCount} chunks -> ${plans.length} segments`);
    } else if (isRetry && hadSegments) {
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
        `[segment] ${meetingId}: retry — attempts/lease/resumes cleared, ` +
        `${countMissingSegments(state.texts, state.total)}/${state.total} segment(s) still missing`
      );
    }

    /* ─── c. Lease check ───────────────────────────────────────── */
    if (leaseIsValid(state.lease, Date.now())) {
      console.log(`[segment] ${meetingId}: segment ${state.lease?.segment} already leased`);
      return json({ busy: true });
    }

    /* ─── d. Transcribe ONE segment ────────────────────────────── */
    const runSegment = async (i: number) => {
      const total = state!.total;
      // A fresh lease per segment: 3 min covers one Gemini call, and the
      // poller only steps in once it has expired.
      await mergeState({
        lease: { segment: i, until: new Date(Date.now() + LEASE_MS).toISOString() },
      });

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
          const boundary = findInitBoundary(chunkZero);
          await uploadToGcs(gcsToken, bucket, initObject, chunkZero.slice(0, boundary), mimeType);
          console.log(`[segment] ${meetingId}: init.webm written (${boundary} bytes)`);
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
            `[segment] ${meetingId}: segment ${i} lead = ${prevChunk.length - leadStart} bytes ` +
            `from chunk ${prevIndex} (offset ${leadStart}/${prevChunk.length})`
          );
        } catch (leadErr) {
          // No usable lead cluster: compose without it. Costs at most one
          // cluster of audio at the seam, never the segment.
          const message = leadErr instanceof Error ? leadErr.message : String(leadErr);
          console.warn(`[segment] ${meetingId}: segment ${i} has no lead cluster — ${message}`);
        }
      }
      for (let k = plan.firstChunk; k <= plan.lastChunk; k++) {
        sources.push(chunkObjectName(folder, k));
      }

      const segmentObject = segmentObjectName(folder, i);
      await composeObjects(gcsToken, bucket, sources, segmentObject, mimeType);
      console.log(
        `[segment] ${meetingId}: composed segment ${i + 1}/${total} ` +
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
      console.log(`[segment] ${meetingId}: segment ${i + 1}/${total} -> ${text.length} chars`);

      // Persist BEFORE anything else can go wrong: this segment is now paid for.
      await mergeState({ texts: { [String(i)]: text }, lease: null });

      try {
        await deleteGeminiFile(GEMINI_API_KEY, fileUri);
      } catch (e) {
        console.warn("[segment] Gemini file delete failed (non-critical):", e);
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
            console.warn(`[segment] cleanup: ${name} not deleted — ${message}`);
          }
        }
        // recording.webm and chunks/ stay: playback and any re-run need them.
        console.log(`[segment] ${meetingId}: cleanup deleted ${deleted}/${targets.length} object(s)`);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn(`[segment] ${meetingId}: cleanup failed (non-critical) — ${message}`);
      }
    };

    try {
      /* ─── C. Budgeted loop: as many segments as fit in this request ── */
      while (true) {
        const next = firstMissingSegment(state.texts, state.total);
        if (next === null) break;
        const elapsed = Date.now() - requestStart;
        if (elapsed >= BUDGET_MS) {
          console.log(
            `[segment] ${meetingId}: budget spent (${Math.round(elapsed / 1000)}s, ` +
            `${processed.length} segment(s) this request) — handing over at segment ${next}`
          );
          break;
        }
        segmentIndex = next;
        await runSegment(next);
        processed.push(next);
        segmentIndex = null;
      }

      const remaining = countMissingSegments(state.texts, state.total);
      if (remaining > 0) {
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

      const { error: updateError } = await supabase
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
        .eq("id", meetingId);
      if (updateError) throw new Error(`Failed to update meeting: ${updateError.message}`);

      console.log(`[segment] ${meetingId}: finalized ${state.total} segments`);
      await cleanupSegmentArtifacts();
      return json({ done: true, total: state.total });
    } catch (workErr) {
      /* ─── g. Segment / finalize failure ────────────────────── */
      const message = workErr instanceof Error ? workErr.message : String(workErr);
      const key = segmentIndex === null ? "final" : String(segmentIndex);
      const label = segmentIndex === null
        ? "Finalize"
        : `Segment ${segmentIndex + 1}/${state?.total ?? 0}`;
      console.error(`[segment] ${meetingId}: ${label} failed —`, message);

      const attemptCount = ((state?.attempts ?? {})[key] ?? 0) + 1;
      await mergeState({ attempts: { [key]: attemptCount }, lease: null });
      await supabase
        .from("focusos_meetings")
        .update({ processing_error: `${label}: ${message}` })
        .eq("id", meetingId);

      if (attemptCount < MAX_SEGMENT_ATTEMPTS) {
        kickSelf(supabaseUrl, serviceKey, meetingId, attemptCount * RETRY_BACKOFF_MS);
        return json({ processed, retry: segmentIndex ?? "final", attempt: attemptCount });
      }

      await supabase
        .from("focusos_meetings")
        .update({ processing_status: "error" })
        .eq("id", meetingId);
      return json({ processed, failed: segmentIndex ?? "final", attempt: attemptCount });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[segment] handler error:", message);
    if (meetingId) {
      try {
        await supabase
          .from("focusos_meetings")
          .update({ processing_error: message })
          .eq("id", meetingId);
      } catch (dbErr) {
        console.error("[segment] failed to record handler error:", dbErr);
      }
    }
    return json({ error: message }, 400);
  }
});
