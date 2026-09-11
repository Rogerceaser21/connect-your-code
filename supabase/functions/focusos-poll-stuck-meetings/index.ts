import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { generateSummary } from "../_shared/gemini.ts";
import {
  leaseIsValid,
  releasedLease,
  scrubSecrets,
  type SegmentsState,
} from "../_shared/segments.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const STUCK_AFTER_SECONDS = 180; // a healthy segment worker touches the row every ~60 s
const MAX_RESUMES = 12;          // 12 nudges is far more than a long meeting needs
const MAX_CHAIN = 60;            // max self-rescheduling iterations (~60 min)
const SLEEP_MS = 60_000;         // 60 seconds between iterations

// @ts-ignore — provided by Supabase edge runtime
declare const EdgeRuntime: { waitUntil: (p: Promise<unknown>) => void };

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  let chainCount = 0;
  try {
    const body = await req.json().catch(() => ({}));
    chainCount = Number(body?.chainCount ?? 0);
  } catch {}

  console.log(`[poller] tick chain=${chainCount}`);

  try {
    const cutoff = new Date(Date.now() - STUCK_AFTER_SECONDS * 1000).toISOString();

    // Find candidates: in-flight rows whose last update is older than cutoff
    const { data: stuckRows, error: fetchErr } = await supabase
      .from("focusos_meetings")
      .select("id, processing_status, processing_error, transcript_segments, transcription_text, summary, duration_seconds, updated_at")
      .in("processing_status", ["transcribing", "summarizing"])
      .lt("updated_at", cutoff);

    if (fetchErr) {
      console.error("[poller] fetch error:", fetchErr);
    }

    const rows = (stuckRows || []) as any[];
    console.log(`[poller] ${rows.length} stuck candidate(s)`);

    for (const row of rows) {
      try {
        // Case A (legacy): a whole-file transcript is already staged → just summarize.
        if (row.transcription_text && (!row.summary || row.processing_status === "summarizing")) {
          console.log(`[poller] finishing summarization for ${row.id}`);
          const summary = await generateSummary(
            GEMINI_API_KEY,
            row.transcription_text,
            "concise",
            row.duration_seconds || 0
          );
          await supabase
            .from("focusos_meetings")
            .update({
              summary,
              processing_status: "done",
              processing_error: null,
              transcription_text: null,
              gemini_file_uri: null,
            })
            .eq("id", row.id);
          continue;
        }

        // Case B: a segmented transcription whose worker chain went quiet.
        if (row.processing_status === "transcribing") {
          const segments = (row.transcript_segments ?? null) as SegmentsState | null;

          if (leaseIsValid(segments?.lease, Date.now())) {
            console.log(`[poller] ${row.id}: segment ${segments?.lease?.segment} still leased — leaving it`);
            continue;
          }

          const resumes = (segments?.resumes ?? 0) + 1;
          // The RELEASED SENTINEL, never null: the worker's takeLease filter is
          // `transcript_segments->lease->>until < now` and a null there matches no
          // row, so a poller that nulled the lease key would hand the worker a
          // meeting it could never lease.
          const nextSegments = { ...(segments ?? {}), resumes, lease: releasedLease() };

          if (resumes > MAX_RESUMES) {
            console.log(`[poller] giving up on ${row.id} after ${resumes - 1} resumes`);
            // KEEP the cause the worker already wrote: "stalled after N resumes"
            // on its own tells nobody why it stalled.
            const stalled = `Transcription stalled after ${MAX_RESUMES} resumes`;
            const cause = scrubSecrets(row.processing_error ?? "", [
              supabaseServiceKey,
              GEMINI_API_KEY,
            ]).trim();
            const { data: failed, error: failErr } = await supabase
              .from("focusos_meetings")
              .update({
                processing_status: "error",
                processing_error: cause
                  ? `${cause} (stalled after ${MAX_RESUMES} resumes)`
                  : stalled,
                transcript_segments: nextSegments,
              })
              .eq("id", row.id)
              // Never flip a meeting that finished in the meantime.
              .eq("processing_status", "transcribing")
              // …and never one that MOVED since this tick read it: the row must
              // still be as stale as it was in the candidate query (writes to
              // focusos_meetings bump updated_at), or a worker that just resumed
              // it would be failed under its feet.
              .lt("updated_at", cutoff)
              .select("id");
            if (failErr) {
              console.warn(`[poller] ${row.id}: give-up write error — ${failErr.message}`);
            } else if (!failed || failed.length === 0) {
              console.log(`[poller] ${row.id}: moved since the read — not failing it this tick`);
            }
            continue;
          }

          /* The resumes counter is the poller's give-up budget, so the write that
           * increments it must be CONDITIONAL on the row not having moved since
           * the read above: a status still 'transcribing' AND an updated_at still
           * older than this tick's cutoff. Without that, a worker that woke up
           * between the read and the write (or a second poller chain) gets a
           * resume charged against it every tick and a healthy meeting is failed
           * at 12. 0 rows affected -> another chain or the worker owns this row,
           * so skip it entirely this tick and do NOT invoke the worker.        */
          const { data: bumped, error: bumpErr } = await supabase
            .from("focusos_meetings")
            .update({ transcript_segments: nextSegments })
            .eq("id", row.id)
            .eq("processing_status", "transcribing")
            .lt("updated_at", cutoff)
            .select("id");
          if (bumpErr) {
            console.warn(`[poller] ${row.id}: resume write error — ${bumpErr.message}`);
            continue;
          }
          if (!bumped || bumped.length === 0) {
            console.log(`[poller] ${row.id}: moved since the read — skipping this tick`);
            continue;
          }
          console.log(`[poller] resuming segmented transcription for ${row.id} (resume ${resumes}/${MAX_RESUMES})`);

          fetch(`${supabaseUrl}/functions/v1/focusos-transcribe-meeting`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${supabaseServiceKey}`,
              apikey: supabaseServiceKey,
            },
            body: JSON.stringify({ meetingId: row.id }),
          }).catch((e) => console.warn("[poller] resume invoke error:", e?.message));
        }
      } catch (rowErr) {
        console.error(`[poller] error processing row ${row.id}:`, rowErr);
      }
    }

    // Decide whether to self-reschedule: are there ANY in-flight rows left?
    const { count } = await supabase
      .from("focusos_meetings")
      .select("id", { count: "exact", head: true })
      .in("processing_status", ["transcribing", "summarizing"]);

    const queueSize = count ?? 0;
    console.log(`[poller] queue size after tick: ${queueSize}`);

    if (queueSize > 0 && chainCount < MAX_CHAIN) {
      const nextChain = chainCount + 1;
      console.log(`[poller] rescheduling self in ${SLEEP_MS}ms (chain=${nextChain})`);
      EdgeRuntime.waitUntil((async () => {
        await new Promise((r) => setTimeout(r, SLEEP_MS));
        try {
          await fetch(`${supabaseUrl}/functions/v1/focusos-poll-stuck-meetings`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${supabaseServiceKey}`,
              apikey: supabaseServiceKey,
            },
            body: JSON.stringify({ chainCount: nextChain }),
          });
        } catch (e) {
          console.warn("[poller] self-reschedule fetch error:", e);
        }
      })());
    } else if (queueSize === 0) {
      console.log("[poller] queue empty — shutting down chain");
    } else {
      console.warn(`[poller] reached MAX_CHAIN=${MAX_CHAIN}, stopping`);
    }

    return new Response(
      JSON.stringify({ ok: true, processed: rows.length, queueSize, chainCount }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[poller] fatal error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
