import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  composeObjects,
  downloadObject,
  getGcsAccessToken,
  listChunkCount,
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
  chunkObjectName,
  findInitBoundary,
  firstMissingSegment,
  formatHMS,
  joinTranscript,
  leaseIsValid,
  planSegments,
  segmentStartSeconds,
  type SegmentsState,
} from "../_shared/segments.ts";

/**
 * SEGMENT WORKER.
 *
 * One request = ONE ~10 minute segment of one meeting, transcribed
 * SYNCHRONOUSLY and well inside the edge worker's budget, then the worker
 * hands the baton to a fresh invocation of itself. Nothing heavy runs in the
 * background, so a worker being recycled costs at most the current segment
 * (the next request re-does it), never the whole meeting.
 *
 * Body: { meetingId }. Every other field is ignored (old clients still send
 * geminiFileUri / gcsBucket / … — harmless).
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SEGMENT_CHUNKS = 20;      // 20 x 30 s chunks = 10 min of audio per Gemini call
const LEASE_MS = 180_000;       // a worker owns its segment for 3 min
const FILE_ACTIVE_CAP_MS = 60_000;
const MAX_SEGMENT_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 5_000; // x attempt number, retry path only

// @ts-ignore — EdgeRuntime is provided by the Supabase edge runtime
declare const EdgeRuntime: { waitUntil: (p: Promise<unknown>) => void };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Hand the baton to a fresh worker (same self-reschedule pattern the poller
 * uses). Fire-and-forget: the caller has already persisted its progress.
 * delayMs is used only on the retry path, so a transient Gemini error does not
 * burn all three attempts within a couple of seconds.
 */
function scheduleNext(
  supabaseUrl: string,
  serviceKey: string,
  meetingId: string,
  delayMs = 0
) {
  try {
    EdgeRuntime.waitUntil((async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      try {
        await fetch(`${supabaseUrl}/functions/v1/focusos-transcribe-meeting`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
            apikey: serviceKey,
          },
          body: JSON.stringify({ meetingId }),
        });
      } catch (e) {
        console.warn("[segment] self-invoke error:", e);
      }
    })());
  } catch (e) {
    console.warn("[segment] scheduleNext threw:", e);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  let meetingId = "";
  let segmentIndex: number | null = null;
  let state: SegmentsState | null = null;

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
    if (meeting.processing_status !== "transcribing") {
      console.log(`[segment] ${meetingId} is '${meeting.processing_status}' — nothing to do`);
      return json({ skipped: meeting.processing_status });
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
    }

    /* ─── c. Lease check + pick the next hole ──────────────────── */
    if (leaseIsValid(state.lease, Date.now())) {
      console.log(`[segment] ${meetingId}: segment ${state.lease?.segment} already leased`);
      return json({ busy: true });
    }

    segmentIndex = firstMissingSegment(state.texts, state.total);

    try {
      if (segmentIndex === null) {
        /* ─── e. FINALIZE ──────────────────────────────────────── */
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
        return json({ done: true, total: state.total });
      }

      /* ─── d. Transcribe ONE segment ──────────────────────────── */
      const i = segmentIndex;
      const total = state.total;
      await mergeState({
        lease: { segment: i, until: new Date(Date.now() + LEASE_MS).toISOString() },
      });

      // Init segment: the EBML header of chunk 00000, which every later chunk
      // lacks. Prepended to each composed segment so it decodes on its own.
      const initObject = `${folder}/init.webm`;
      if (!state.initReady) {
        const chunkZero = await downloadObject(gcsToken, bucket, chunkObjectName(folder, 0));
        const boundary = findInitBoundary(chunkZero);
        await uploadToGcs(gcsToken, bucket, initObject, chunkZero.slice(0, boundary), mimeType);
        console.log(`[segment] ${meetingId}: init.webm written (${boundary} bytes)`);
        await mergeState({ initReady: true });
      }

      const plan = planSegments(state.chunkCount, state.segmentChunks)[i];
      if (!plan) throw new Error(`No plan for segment ${i} of ${total}`);

      const sources = [initObject];
      for (let k = plan.firstChunk; k <= plan.lastChunk; k++) {
        sources.push(chunkObjectName(folder, k));
      }
      const segmentObject = `${folder}/segments/${String(i).padStart(2, "0")}.webm`;
      await composeObjects(gcsToken, bucket, sources, segmentObject, mimeType);
      console.log(
        `[segment] ${meetingId}: composed segment ${i + 1}/${total} (chunks ${plan.firstChunk}-${plan.lastChunk})`
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
      const participantsLine = participantNames.length > 0
        ? ` The participants are: ${participantNames.join(", ")}. Label each speaker by their name where possible.`
        : " Include speaker diarization where possible (label speakers as Speaker 1, Speaker 2, etc.).";
      const previousTail = i > 0 ? (state.texts[String(i - 1)] || "").slice(-600) : "";
      const continuityLine = previousTail
        ? ` Keep speaker labels consistent with the end of the previous part, which was: ${previousTail}`
        : "";

      const prompt = `This is part ${i + 1} of ${total} of one meeting recording. This part starts at ${
        formatHMS(segmentStartSeconds(i, state.segmentChunks))
      } of the meeting.${participantsLine} Transcribe it as a clean transcript with speaker labels. Do not include timestamps.${continuityLine}`;

      const text = await transcribeSegment(GEMINI_API_KEY, fileUri, mimeType, prompt);
      console.log(`[segment] ${meetingId}: segment ${i + 1}/${total} -> ${text.length} chars`);

      await mergeState({ texts: { [String(i)]: text }, initReady: true, lease: null });

      try {
        await deleteGeminiFile(GEMINI_API_KEY, fileUri);
      } catch (e) {
        console.warn("[segment] Gemini file delete failed (non-critical):", e);
      }

      scheduleNext(supabaseUrl, serviceKey, meetingId);
      return json({ segment: i, total });
    } catch (workErr) {
      /* ─── f. Segment / finalize failure ────────────────────── */
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
        scheduleNext(supabaseUrl, serviceKey, meetingId, attemptCount * RETRY_BACKOFF_MS);
        return json({ retry: segmentIndex ?? "final", attempt: attemptCount });
      }

      await supabase
        .from("focusos_meetings")
        .update({ processing_status: "error" })
        .eq("id", meetingId);
      return json({ failed: segmentIndex ?? "final", attempt: attemptCount });
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
