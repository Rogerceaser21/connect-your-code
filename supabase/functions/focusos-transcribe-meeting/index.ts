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
  parseRecordingPath,
  planSegments,
  releasedLease,
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
// 5 min: above the TYPICAL segment (compose ~2 s + GCS->Gemini upload + ACTIVE
// wait + generateContent, tens of seconds each). It is NOT above the sum of every
// leg's timeout cap (a first segment i>0 can spend up to five 60 s GCS legs plus
// 242 s of Gemini legs), so an owner CAN outlive its lease on a pathologically
// slow day. Correctness never rests on the lease alone: every state write is
// token-owned, so an expired owner stands down and at most one segment's Gemini
// call is repeated.
const LEASE_MS = 300_000;
// 60 s: a segment may START at the very end of the budget, so the request's own
// ceiling is BUDGET_MS + one worst-case segment (~242 s) + finalize, which keeps
// it under the 400 s edge-function wall clock.
const BUDGET_MS = 60_000;       // stop STARTING segments after this much wall clock
const FILE_ACTIVE_CAP_MS = 60_000;
// The edge runtime's own wall clock, and what finalize needs inside it: the
// summary is one more Gemini call (bounded at 120 s) plus the transcript upload
// and the artifact cleanup. A request that already spent WALL_CLOCK_MS minus
// this reserve on segments hands the finalize to a fresh worker rather than
// being cut off in the middle of it.
const WALL_CLOCK_MS = 400_000;
const FINALIZE_RESERVE_MS = 150_000;
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
      try {
        await fetch(pollerUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
            apikey: serviceKey,
          },
          body: JSON.stringify({ chainCount }),
          signal: AbortSignal.timeout(KICK_ABORT_MS),
        });
      } catch (e) {
        const name = (e as { name?: string })?.name ?? String(e);
        console.log(`[segment ${INSTANCE}] armPoller released (${name})`);
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
  // NO armPoller here. Each request arms the watchdog EXACTLY once (right after
  // the plan is durable), and the callee arms it again for itself; arming from
  // inside the handover made every hop start a second 60-tick poller chain.
  try {
    EdgeRuntime.waitUntil((async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      try {
        // Bounded by the abort signal: this never waits for the segments the
        // next worker is about to do, only for the request to be delivered.
        await fetch(selfUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
            apikey: serviceKey,
          },
          body: JSON.stringify({ meetingId }),
          signal: AbortSignal.timeout(KICK_ABORT_MS),
        });
      } catch (e) {
        // AbortError is the EXPECTED outcome, not a failure: the next worker
        // keeps running without us.
        const name = (e as { name?: string })?.name ?? String(e);
        console.log(`[segment ${INSTANCE}] kickSelf released (${name})`);
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
  // The lease token this worker currently holds (null between segments). The
  // failure path needs it: releasing a lease is an OWNED write, and a worker that
  // never got the lease must not touch the key at all.
  let leaseToken: string | null = null;
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
   * Merge + write ONLY while this worker still HOLDS the lease it took.
   *
   * WHY a second variant: mergeState's guard is the status alone, so a worker
   * whose lease expired mid-segment (a slow Gemini call) could still overwrite
   * transcript_segments AFTER a second worker legitimately took that segment —
   * two workers leapfrogging through the same segments. The token makes the
   * CURRENT lease part of the write condition, evaluated inside Postgres:
   *
   *   id = meetingId
   *   AND processing_status = 'transcribing'
   *   AND transcript_segments->'lease'->>'token' = <the token WE were granted>
   *
   * THREE PLAIN FILTERS, no logic tree. This project's PostgREST rejects ANY
   * `or=(...)` / `and=(...)` on a PATCH with 42703 "column ... does not exist",
   * even for a plain column (live-probed 2026-09-11: the same tree on a GET is
   * 200, a plain filter on a jsonb path on a PATCH is 200). That is what killed
   * every meeting at its first lease take before this round.
   *
   * There is no "already released" arm: a lease that is not ours is a lease we
   * LOST, and the owner's state is the authoritative one.
   *
   * Returns false when the write touched no row ("lease lost"): the caller stands
   * down and writes nothing further. A real DB error still throws.
   */
  const mergeStateOwned = async (
    token: string,
    patch: Partial<SegmentsState>,
  ): Promise<boolean> => {
    const merged = await mergeRead(patch);
    const { data, error } = await supabase
      .from("focusos_meetings")
      .update({ transcript_segments: merged })
      .eq("id", meetingId)
      .eq("processing_status", "transcribing")
      .eq("transcript_segments->lease->>token", token)
      .select("id");
    if (error) throw new Error(`Owned state write failed: ${error.message}`);
    if (!data || data.length === 0) {
      console.warn(
        `[segment ${INSTANCE}] ${meetingId}: lease lost (token no longer ours) — ` +
        `another worker owns this segment, standing down without writing`
      );
      return false;
    }
    state = merged;
    return true;
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
   *   AND transcript_segments->'lease'->>'until' < now
   *
   * ONE PLAIN FILTER on the lease, because a logic tree is not available here:
   * any `or=(...)` on a PATCH is 42703 on this project (live-probed 2026-09-11).
   * A plain `<` cannot also mean "or it is null", which is exactly why a released
   * lease is the SENTINEL (segment -1, `until` at the epoch) and never null — an
   * SQL NULL on the left of `<` matches no row, i.e. a null lease would be
   * un-takeable.
   *
   * `until` is always written with new Date().toISOString(): PostgREST compares a
   * `->>` path as TEXT, and that format is fixed-width, so the text comparison
   * against nowIso (same format) is chronological.
   *
   * Returns the granted TOKEN (the caller passes it to every later write) or null
   * when someone else holds a live lease.
   */
  const takeLease = async (i: number): Promise<string | null> => {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const token = crypto.randomUUID();
    const merged = await mergeRead({
      lease: { segment: i, until: new Date(now + LEASE_MS).toISOString(), token },
    });
    const { data, error } = await supabase
      .from("focusos_meetings")
      .update({ transcript_segments: merged })
      .eq("id", meetingId)
      .eq("processing_status", "transcribing")
      .lt("transcript_segments->lease->>until", nowIso)
      .select("id");
    if (error) throw new Error(`Lease update failed: ${error.message}`);
    if (!data || data.length === 0) return null;
    state = merged;
    return token;
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

    /* ─── a2. Ownership ─────────────────────────────────────────────
     * The gateway verified the JWT's SIGNATURE (verify_jwt is on by default for
     * this function), not WHOSE it is, and every write below runs with the
     * service role. So a caller that is not the poller or a self-kick (both of
     * which send the service-role key) must prove it owns this row — BEFORE
     * anything is written.                                                  */
    const bearer = (req.headers.get("Authorization") ?? "")
      .replace(/^Bearer\s+/i, "")
      .trim();
    if (bearer !== serviceKey) {
      const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || serviceKey;
      const authClient = createClient(supabaseUrl, anonKey);
      const { data: caller, error: callerErr } = await authClient.auth.getUser(bearer);
      if (callerErr || !caller?.user || caller.user.id !== meeting.user_id) {
        console.warn(
          `[segment ${INSTANCE}] ${meetingId}: forbidden caller ` +
          `(${callerErr?.message ?? "not the owner of this meeting"})`
        );
        return json({ error: "Forbidden" }, 403);
      }
    }

    /* A retry re-opens a meeting that is 'error', AND one that still says
     * 'transcribing' with NO live lease. The second case is the normal one: the
     * client resets the row to transcribing / error null / attempts 0 and then
     * invokes with retry:true, and a chain that died mid-flight leaves the row
     * exactly there too. Only a LIVE lease means a worker is really on it.   */
    const leaseLive = leaseIsValid(
      (meeting.transcript_segments as SegmentsState | null)?.lease,
      Date.now(),
    );
    const isReopen = isRetry && (
      meeting.processing_status === "error" ||
      (meeting.processing_status === "transcribing" && !leaseLive)
    );

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
    } else if (isRetry && !isReopen) {
      // A retry against a LIVE lease must NOT clear it: that is how two workers
      // end up on the same segment. The run in flight keeps its lease; if it is
      // really dead, the next retry (or the poller) resumes it once it expires.
      console.log(
        `[segment ${INSTANCE}] ${meetingId}: retry ignored — segment ` +
        `${(meeting.transcript_segments as SegmentsState | null)?.lease?.segment} is leased`
      );
      armPoller(supabaseUrl, serviceKey, 0);
      return json({ busy: true });
    } else if (isReopen) {
      // Already 'transcribing' with a dead (or no) lease. Clear the stale cause
      // here; attempts / lease / resumes are cleared with the state below.
      await supabase
        .from("focusos_meetings")
        .update({ processing_error: null })
        .eq("id", meetingId)
        .eq("processing_status", "transcribing");
      console.log(`[segment ${INSTANCE}] ${meetingId}: retry re-opened a stalled 'transcribing' meeting`);
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
    // BOTH production shapes: <folder>/recording.webm (composed) and
    // <folder>/chunks/00000.webm (chunk_count === 1, a sub-30 s recording that
    // focusos-process-meeting never composes). See parseRecordingPath.
    const parsedPath = parseRecordingPath(meeting.recording_gcs_path);
    if (!parsedPath) {
      throw new Error(`Cannot parse recording_gcs_path: ${meeting.recording_gcs_path}`);
    }
    const { bucket, folder } = parsedPath;

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
        // The RELEASED SENTINEL, never null: takeLease's filter is
        // `lease->>until < now`, and a null there matches no row at all.
        lease: releasedLease(),
      };
      await supabase
        .from("focusos_meetings")
        .update({ transcript_segments: state })
        .eq("id", meetingId);
      console.log(`[segment ${INSTANCE}] ${meetingId}: ${chunkCount} chunks -> ${plans.length} segments`);
    } else if (isReopen) {
      /* ─── D. RETRY ─────────────────────────────────────────────
       * Keep the texts and the plan, drop everything that stops work:
       * the failure attempts, the poller's resume budget, and any lease
       * (a retry deliberately pre-empts a worker that went quiet).      */
      if (!state.lease || typeof state.lease !== "object") {
        // The guarded write below filters on lease->>until; a missing or null
        // lease key matches no row, so normalise it to the released sentinel
        // first (same invariant as step b1, which runs too late for this branch).
        state = await mergeState({ lease: releasedLease() });
      }
      state = { ...state, attempts: {}, resumes: 0, lease: releasedLease() };
      // Guarded like takeLease: a lease that went live between the row read and
      // this write (a double Retry click, or the poller resuming at the same
      // moment) must not be clobbered. Zero rows = someone holds it: stand down.
      const { data: reopened, error: reopenErr } = await supabase
        .from("focusos_meetings")
        .update({ transcript_segments: state, processing_error: null })
        .eq("id", meetingId)
        .eq("processing_status", "transcribing")
        .lt("transcript_segments->lease->>until", new Date().toISOString())
        .select("id");
      if (reopenErr) throw new Error(`Retry state write failed: ${reopenErr.message}`);
      if (!reopened || reopened.length === 0) {
        console.log(`[segment ${INSTANCE}] ${meetingId}: retry lost the race to a live lease — busy`);
        armPoller(supabaseUrl, serviceKey, 0);
        return json({ busy: true });
      }
      console.log(
        `[segment ${INSTANCE}] ${meetingId}: retry — attempts/lease/resumes cleared, ` +
        `${countMissingSegments(state.texts, state.total)}/${state.total} segment(s) still missing`
      );
    }

    /* ─── b1. INVARIANT: the lease key is an OBJECT, never null ─────
     * takeLease's only lease filter is `transcript_segments->lease->>until < now`
     * (a PATCH cannot carry an or= tree on this project — 42703), and an SQL NULL
     * on the left of `<` matches NO row. So a row that reached here without a
     * lease object (a row planned before this rule, or a hand-edited one) would
     * be permanently un-leasable. Normalise it to the released sentinel first;
     * this is a status-guarded plain write, and on the normal path it is skipped
     * because the planner / retry branch already wrote a sentinel.            */
    if (!state.lease || typeof state.lease !== "object") {
      state = await mergeState({ lease: releasedLease() });
      console.log(
        `[segment ${INSTANCE}] ${meetingId}: lease key was absent — released sentinel written`
      );
    }

    /* ─── b2. PROVE the container before spending anything ──────────
     * chunk 00000 must open with the EBML magic. A browser without MediaRecorder
     * WebM support records audio/mp4, which has no EBML header and no Clusters,
     * so every boundary search is meaningless and Gemini would be paid to
     * transcribe a file the composer mangled. ~150-250 KB, ONCE per meeting:
     * the proof is persisted as format:'webm' and later requests skip it. A
     * failure here throws, and the outer catch parks the row as 'error' with
     * this readable cause on the FIRST request instead of after a wasted call. */
    let chunkZeroBytes: Uint8Array | null = null;
    if (state.format !== "webm") {
      chunkZeroBytes = await downloadObject(gcsToken, bucket, chunkObjectName(folder, 0));
      if (!isWebm(chunkZeroBytes)) {
        throw new Error(
          `Recording is not WebM (first bytes ${hexHead(chunkZeroBytes)}); ` +
          "segmented transcription supports WebM only"
        );
      }
      state = await mergeState({ format: "webm" });
      console.log(
        `[segment ${INSTANCE}] ${meetingId}: chunk 0 is WebM ` +
        `(${hexHead(chunkZeroBytes)}) — format flagged, later requests skip the sniff`
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
    // `token` is the lease token takeLease granted for segment i (a parameter, not
    // the outer leaseToken, so nothing here can shadow the failure path's copy).
    const runSegment = async (i: number, token: string): Promise<boolean> => {
      const total = state!.total;
      // The lease on segment i is ALREADY held: the caller took it with
      // takeLease(i) (one conditional UPDATE) and passes the TOKEN it was
      // granted, which is the only safe way to claim a segment when three
      // different callers can start this worker.

      const plan = planSegments(state!.chunkCount, state!.segmentChunks)[i];
      if (!plan) throw new Error(`No plan for segment ${i} of ${total}`);

      // Segment 0 needs nothing prepended: chunk 00000 carries the EBML header
      // and starts on a Cluster. Every later segment needs the header, plus the
      // head of the Cluster that the chunk boundary cut in half.
      const sources: string[] = [];
      if (i > 0) {
        const initObject = initObjectName(folder);
        if (!state!.initReady) {
          // Reuse the bytes step b2 already downloaded in THIS request; a
          // request that skipped the sniff (format already flagged) fetches now.
          const chunkZero = chunkZeroBytes ??
            await downloadObject(gcsToken, bucket, chunkObjectName(folder, 0));
          // Belt and braces: b2 (or an earlier request) already proved this.
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
      // ONE owned write does both halves — store the text and release the lease
      // — so a worker whose lease expired mid-call cannot overwrite the state of
      // the worker that legitimately took segment i.
      const kept = await mergeStateOwned(token, {
        texts: { [String(i)]: text },
        lease: releasedLease(),
      });

      try {
        await deleteGeminiFile(GEMINI_API_KEY, fileUri);
      } catch (e) {
        console.warn(`[segment ${INSTANCE}] Gemini file delete failed (non-critical):`, e);
      }
      return kept;
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
        // The error label belongs to THIS segment from here on: a takeLease
        // failure is "Segment i/N: ...", not "Finalize: ..." (it happens before
        // any segment work, and reading "Finalize" on a meeting with 8 missing
        // segments sent the last round of diagnosis down the wrong path).
        segmentIndex = next;
        // ONE conditional UPDATE decides who owns this segment; it hands back the
        // token every later write of ours must carry.
        const token = await takeLease(next);
        if (!token) {
          console.log(
            `[segment ${INSTANCE}] ${meetingId}: segment ${next} was leased by another ` +
            `worker — standing down after ${processed.length} segment(s)`
          );
          return json({ processed, busy: true });
        }
        leaseToken = token;
        const kept = await runSegment(next, token);
        segmentIndex = null;
        leaseToken = null;
        if (!kept) {
          // The lease expired under us and another worker owns segment `next`.
          // Write NOTHING more (the owner's state is authoritative) and let it
          // carry the chain.
          return json({ processed, leaseLost: next });
        }
        processed.push(next);
      }

      const remaining = countMissingSegments(state.texts, state.total);
      if (remaining > 0) {
        // Hand over only; the watchdog was armed once, above, for this request
        // (and the next worker arms it once for itself).
        kickSelf(supabaseUrl, serviceKey, meetingId);
        return json({ processed, remaining });
      }

      /* ─── f. FINALIZE ────────────────────────────────────────── */
      // A segment that started at the end of the budget can run for ~4 more
      // minutes (upload 60 s + ACTIVE 60 s + generate 120 s), which leaves no
      // room for the summary call. Hand over: the next worker sees zero missing
      // segments and finalizes immediately with a full wall clock.
      const spentMs = Date.now() - requestStart;
      if (spentMs > WALL_CLOCK_MS - FINALIZE_RESERVE_MS) {
        console.log(
          `[segment ${INSTANCE}] ${meetingId}: ${Math.round(spentMs / 1000)}s spent — ` +
          `handing the finalize to a fresh worker`
        );
        kickSelf(supabaseUrl, serviceKey, meetingId);
        return json({ processed, handover: "finalize", spentMs });
      }

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
        lease: releasedLease(),
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
      try {
        if (leaseToken) {
          // We hold the lease: record the attempt AND release it (the sentinel,
          // never null) in ONE token-owned write, so a lease a second worker has
          // since taken is left exactly as it is.
          const kept = await mergeStateOwned(leaseToken, {
            attempts: { [key]: attemptCount },
            lease: releasedLease(),
          });
          if (!kept) {
            // The lease is no longer ours (it expired and another worker took the
            // segment): that worker owns the outcome now. Writing processing_error
            // or 'error' here would stamp a failure under a healthy holder, so
            // stand down without touching the row.
            console.warn(
              `[segment ${INSTANCE}] ${meetingId}: ${label} failed after the lease was lost — standing down`
            );
            return json({ processed, leaseLost: segmentIndex, attempt: attemptCount });
          }
        } else {
          // No lease is held — a finalize failure (the last segment's write
          // released it) or a takeLease that threw before it was granted — so
          // record the attempt only and do not touch the lease key.
          await mergeState({ attempts: { [key]: attemptCount } });
        }
      } catch (stateErr) {
        console.warn(
          `[segment ${INSTANCE}] ${meetingId}: could not record the failure state —`,
          scrubSecrets(stateErr, [serviceKey, Deno.env.get("GEMINI_API_KEY")])
        );
        if (leaseToken) {
          // Ownership is unknown (the owned write itself failed), so never stamp
          // an error that might land under another holder. The lease expires on
          // its own and the poller resumes the meeting.
          return json({ processed, leaseUnknown: segmentIndex, attempt: attemptCount });
        }
      }
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
        // FAIL the row, do not leave it spinning. Everything that reaches this
        // catch is DETERMINISTIC — no chunks, an unparseable recording path, a
        // non-WebM container, a missing env var — so 12 poller resumes (~40 min)
        // would repeat the same failure before the card ever showed "Failed".
        // The status guard means a row another worker finished is left alone,
        // and a retry re-opens this one (isReopen above).
        await supabase
          .from("focusos_meetings")
          .update({ processing_status: "error", processing_error: message })
          .eq("id", meetingId)
          .eq("processing_status", "transcribing");
      } catch (dbErr) {
        console.error(`[segment ${INSTANCE}] failed to record handler error:`, dbErr);
      }
      // Best effort: if the write above touched no row (the meeting moved on
      // under us), the watchdog is still the thing that rescues it.
      armPoller(supabaseUrl, serviceKey, 0);
    }
    return json({ error: message }, 400);
  }
});
