import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  getGcsAccessToken,
  uploadToGcs,
  type ServiceAccount,
} from "../_shared/gcs.ts";
import { generateSummary } from "../_shared/gemini.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

async function handleResummarize(
  supabase: any,
  meetingId: string,
  transcript: string,
  detailLevel: string,
  durationSeconds: number,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");

  let transcriptText = transcript;
  if (!transcriptText) {
    const { data: meeting, error } = await supabase
      .from("focusos_meetings")
      .select("transcript_gcs_path, duration_seconds")
      .eq("id", meetingId)
      .single();

    if (error || !meeting) throw new Error("Meeting not found");
    if (meeting.duration_seconds) durationSeconds = meeting.duration_seconds;

    if (meeting.transcript_gcs_path) {
      const gcsKeyJson = Deno.env.get("GCS_SERVICE_ACCOUNT_JSON");
      if (!gcsKeyJson) throw new Error("GCS_SERVICE_ACCOUNT_JSON not configured");
      const sa: ServiceAccount = JSON.parse(gcsKeyJson);
      const token = await getGcsAccessToken(sa);
      const gcsBucket = Deno.env.get("GCS_BUCKET_NAME")!;

      const path = meeting.transcript_gcs_path.replace(`gs://${gcsBucket}/`, "");
      const encodedPath = encodeURIComponent(path);
      const gcsResp = await fetch(
        `https://storage.googleapis.com/storage/v1/b/${gcsBucket}/o/${encodedPath}?alt=media`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (gcsResp.ok) {
        const transcriptData = await gcsResp.json();
        transcriptText = transcriptData.transcript || "";
      }
    }
  }

  if (!transcriptText) throw new Error("No transcript available to re-summarize");

  console.log(`Re-summarizing meeting ${meetingId} at detail level: ${detailLevel}`);
  const summary = await generateSummary(GEMINI_API_KEY, transcriptText, detailLevel, durationSeconds);

  const { error: updateError } = await supabase
      .from("focusos_meetings")
    .update({ summary })
    .eq("id", meetingId);

  if (updateError) throw new Error(`Failed to update meeting: ${updateError.message}`);

  return new Response(
    JSON.stringify({ summary, detailLevel }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

/* ─── Main handler ──────────────────────────────────────────────── */

serve(async (req) => {
  console.log("GEMINI suffix:", (Deno.env.get("GEMINI_API_KEY") || "").slice(-4));
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing authorization header");
    const token = authHeader.replace("Bearer ", "");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
    } = await supabase.auth.getUser(token);
    if (!user) throw new Error("Unauthorized");

    // Parse request
    const body = await req.json();
    const { audioBase64, mimeType, projectId, title, durationSeconds, participants, resummarize, meetingId, detailLevel, transcript: providedTranscript, sessionId } = body;

    // ─── Re-summarize flow ───
    if (resummarize && meetingId) {
      return await handleResummarize(supabase, meetingId, providedTranscript, detailLevel || "concise", durationSeconds || 0, corsHeaders);
    }

    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
    if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");

    const gcsKeyJson = Deno.env.get("GCS_SERVICE_ACCOUNT_JSON");
    if (!gcsKeyJson) throw new Error("GCS_SERVICE_ACCOUNT_JSON not configured");
    const serviceAccount: ServiceAccount = JSON.parse(gcsKeyJson);

    const gcsBucket = Deno.env.get("GCS_BUCKET_NAME");
    if (!gcsBucket) throw new Error("GCS_BUCKET_NAME not configured");

    const gcsToken = await getGcsAccessToken(serviceAccount);

    const participantNames = (participants || [])
      .filter((p: any) => p.name?.trim())
      .map((p: any) => p.name.trim());

    let audioGcsPath: string;
    let actualMimeType = mimeType || "audio/webm";

    // ─── Session-based chunked flow (BULLETPROOF: Gemini File API) ───
    if (sessionId) {
      console.log(`Processing session ${sessionId} (chunked upload)...`);

      // Get session info
      const { data: session, error: sessionError } = await supabase
        .from("focusos_recording_sessions")
        .select("*")
        .eq("id", sessionId)
        .eq("user_id", user.id)
        .single();

      if (sessionError || !session) throw new Error("Recording session not found");

      actualMimeType = (session.mime_type || "audio/webm").split(";")[0];

      // Mark session as processing
      await supabase
        .from("focusos_recording_sessions")
        .update({ status: "processing" })
        .eq("id", sessionId);

      // Compose chunks using GCS Compose API
      console.log(`Composing ${session.chunk_count} chunks...`);
      const composedPath = `${session.gcs_folder_path}/recording.webm`;

      let sourceObjects: string[] = [];
      for (let i = 0; i < session.chunk_count; i++) {
        const paddedIndex = String(i).padStart(5, "0");
        sourceObjects.push(`${session.gcs_folder_path}/chunks/${paddedIndex}.webm`);
      }

      // Multi-pass compose if > 32 chunks
      while (sourceObjects.length > 1) {
        const batches: string[][] = [];
        for (let i = 0; i < sourceObjects.length; i += 32) {
          batches.push(sourceObjects.slice(i, i + 32));
        }

        const newSources: string[] = [];
        for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
          const batch = batches[batchIdx];
          if (batch.length === 1) {
            newSources.push(batch[0]);
            continue;
          }

          const destName = batches.length === 1 && sourceObjects.length <= 32
            ? composedPath
            : `${session.gcs_folder_path}/composed_${batchIdx}_${Date.now()}.webm`;

          const composeBody = {
            sourceObjects: batch.map((name) => ({ name })),
            destination: { contentType: actualMimeType },
          };

          const encodedDest = encodeURIComponent(destName);
          const composeResp = await fetch(
            `https://storage.googleapis.com/storage/v1/b/${gcsBucket}/o/${encodedDest}/compose`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${gcsToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(composeBody),
            }
          );

          if (!composeResp.ok) {
            const err = await composeResp.text();
            throw new Error(`GCS compose failed: ${err}`);
          }
          await composeResp.json();
          newSources.push(destName);
        }
        sourceObjects = newSources;
      }

      const composedObjectPath = sourceObjects[0] || composedPath;
      audioGcsPath = `gs://${gcsBucket}/${composedObjectPath}`;
      console.log("Composed audio at:", audioGcsPath);

      // NO whole-file Gemini upload here any more: focusos-transcribe-meeting
      // composes and transcribes ONE ~10 minute segment per invocation, so a
      // long meeting never depends on a single edge worker surviving.
      // recording.webm above is still composed — playback and download need it.

      // Create the meeting record immediately with processing_status = 'transcribing'
      const meetingTitle = title || `Meeting ${new Date().toLocaleDateString()}`;
      const { data: meeting, error: dbError } = await supabase
        .from("focusos_meetings")
        .insert({
          user_id: user.id,
          project_id: projectId || null,
          title: meetingTitle,
          duration_seconds: durationSeconds || 0,
          summary: null,
          action_items: [],
          participants: participants || [],
          recording_gcs_path: audioGcsPath,
          transcript_gcs_path: null,
          processing_status: "transcribing",
          gemini_file_uri: null,
          transcript_segments: null,
        })
        .select()
        .single();

      if (dbError) throw new Error(`Failed to save meeting: ${dbError.message}`);
      console.log("Meeting created with processing_status=transcribing:", meeting.id);

      // Mark recording session done
      await supabase
        .from("focusos_recording_sessions")
        .update({ status: "done" })
        .eq("id", sessionId);

      // The frontend only needs the id to trigger focusos-transcribe-meeting;
      // the rest is kept for logging / backwards compatibility.
      return new Response(
        JSON.stringify({
          id: meeting.id,
          title: meetingTitle,
          processing_status: "transcribing",
          durationSeconds: durationSeconds || 0,
          gcsBucket,
          gcsFolder: session.gcs_folder_path,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── Legacy single-payload flow (backward compat) ───
    if (!audioBase64) throw new Error("No audio data provided");

    console.log("Step 1: Getting GCS access token...");

    console.log("Step 2: Uploading audio to GCS...");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const audioPath = `${user.id}/${timestamp}/recording.webm`;
    const audioBytes = Uint8Array.from(atob(audioBase64), (c) =>
      c.charCodeAt(0)
    );
    audioGcsPath = await uploadToGcs(
      gcsToken,
      gcsBucket,
      audioPath,
      audioBytes,
      actualMimeType
    );
    console.log("Audio uploaded:", audioGcsPath);

    console.log("Step 3: Transcribing with Gemini...");
    const transcribeBody = {
      contents: [
        {
          parts: [
            {
              inlineData: {
                mimeType: actualMimeType,
                data: audioBase64,
              },
            },
            {
              text: `Transcribe this audio recording of a meeting.${
                participantNames.length > 0
                  ? ` The participants are: ${participantNames.join(", ")}. Label each speaker by their name where possible.`
                  : " Include speaker diarization where possible (label speakers as Speaker 1, Speaker 2, etc.)."
              }
              
Format the output as a clean transcript with speaker labels and timestamps where detectable. Be thorough and accurate.`,
            },
          ],
        },
      ],
    };

    const transcribeResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(transcribeBody),
      }
    );

    if (!transcribeResp.ok) {
      const errText = await transcribeResp.text();
      console.error("Gemini transcription error:", errText);
      throw new Error(`Transcription failed: ${errText}`);
    }

    const transcribeData = await transcribeResp.json();
    const transcript =
      transcribeData.candidates?.[0]?.content?.parts?.[0]?.text || "";
    console.log("Transcript length:", transcript.length);

    if (!transcript) {
      throw new Error("Empty transcript returned from Gemini");
    }

    console.log("Step 4: Uploading transcript to GCS...");
    const transcriptPath = `${user.id}/${timestamp}/transcript.json`;
    const transcriptJson = JSON.stringify({ transcript, timestamp });
    const transcriptGcsPath = await uploadToGcs(
      gcsToken,
      gcsBucket,
      transcriptPath,
      transcriptJson,
      "application/json"
    );

    console.log("Step 5: Generating structured summary...");
    const summary = await generateSummary(GEMINI_API_KEY, transcript, "concise", durationSeconds || 0);
    console.log("Summary generated");

    console.log("Step 6: Saving meeting to database...");

    const { data: meeting, error: dbError } = await supabase
      .from("focusos_meetings")
      .insert({
        user_id: user.id,
        project_id: projectId || null,
        title: title || `Meeting ${new Date().toLocaleDateString()}`,
        duration_seconds: durationSeconds || 0,
        summary,
        action_items: [],
        participants: participants || [],
        recording_gcs_path: audioGcsPath,
        transcript_gcs_path: transcriptGcsPath,
        processing_status: "done",
      })
      .select()
      .single();

    if (dbError) {
      console.error("DB error:", dbError);
      throw new Error(`Failed to save meeting: ${dbError.message}`);
    }

    console.log("Meeting saved:", meeting.id);

    return new Response(
      JSON.stringify({
        id: meeting.id,
        title: meeting.title,
        summary,
        transcript,
        duration_seconds: durationSeconds,
        processing_status: "done",
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Process meeting error:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
