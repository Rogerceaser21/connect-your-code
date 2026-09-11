/**
 * Pure helpers for segmented meeting transcription.
 *
 * NO I/O, NO Deno.env, NO fetch — everything here is deterministic and unit
 * tested by segments_test.ts. Keep it that way: this is the only place where
 * the WebM init-boundary rule and the segment arithmetic live.
 */

/** One segment of a recording: a contiguous, inclusive run of chunk indices. */
export interface SegmentPlan {
  index: number;
  firstChunk: number;
  lastChunk: number;
}

/**
 * The lease a worker takes while it transcribes one segment.
 *
 * ALWAYS an object, NEVER null: the lease filters are PLAIN PostgREST filters on
 * the jsonb path (`transcript_segments->lease->>until` / `->>token`), because any
 * `or=(...)` / `and=(...)` logic tree on a PATCH is rejected by this project's
 * PostgREST with 42703 "column ... does not exist" (live-probed 2026-09-11, the
 * same filter on a GET is 200). A plain filter cannot say "is null OR expired",
 * and a NULL on the left of `<` matches nothing, so a released lease is written
 * as the SENTINEL (see releasedLease) instead of null.
 */
export interface SegmentLease {
  /** The segment this lease covers; -1 in the released sentinel. */
  segment: number;
  /** ISO timestamp (or epoch ms) after which the lease is dead. */
  until: string | number;
  /**
   * Random per-take id. The ONLY thing that proves a write belongs to the worker
   * that took the lease: `->>token = <mine>` is one plain filter, evaluated
   * inside Postgres at write time.
   */
  token: string;
}

/**
 * `until` of the released sentinel: the epoch, so it is in the past forever and
 * sorts BEFORE any real timestamp as TEXT too (PostgREST compares a `->>` path
 * as text, and toISOString() is fixed-width, so lexical order === chronological
 * order).
 */
export const RELEASED_LEASE_UNTIL = "1970-01-01T00:00:00.000Z";

/**
 * A FRESH released-lease sentinel: "no worker holds this meeting".
 *
 * A function, not a shared const, so no caller can mutate the value every other
 * write depends on. segment -1 (no segment) + an epoch `until` (expired) + an
 * empty token (matches nobody's write), which is exactly what takeLease's
 * `->>until < now` filter needs to see to grant the lease.
 */
export function releasedLease(): SegmentLease {
  return { segment: -1, until: RELEASED_LEASE_UNTIL, token: "" };
}

/** Shape of focusos_meetings.transcript_segments. */
export interface SegmentsState {
  total: number;
  chunkCount: number;
  segmentChunks: number;
  initReady: boolean;
  texts: Record<string, string>;
  attempts: Record<string, number>;
  resumes: number;
  /**
   * Nullable for READS only (a legacy row, or a row planned before the sentinel
   * rule). Nothing ever WRITES null here — see SegmentLease / releasedLease.
   */
  lease: SegmentLease | null;
  /**
   * Set to "webm" once chunk 00000 has been PROVEN to carry the EBML magic.
   * Absent on a row whose container was never sniffed, which is what makes the
   * worker download chunk 0 once and fail fast on an mp4 recording.
   */
  format?: "webm";
}

export const DEFAULT_SEGMENT_CHUNKS = 20; // 20 x 30 s = 10 min of audio per Gemini call
export const DEFAULT_CHUNK_SECONDS = 30;

/** First four bytes of a WebM Cluster element id: 1F 43 B6 75. */
const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75];

/**
 * Split chunkCount chunks into contiguous segments of segmentChunks each
 * (the last segment absorbs the remainder).
 */
export function planSegments(
  chunkCount: number,
  segmentChunks: number = DEFAULT_SEGMENT_CHUNKS,
): SegmentPlan[] {
  if (!Number.isFinite(chunkCount) || chunkCount <= 0) return [];
  if (!Number.isFinite(segmentChunks) || segmentChunks <= 0) {
    throw new Error("segmentChunks must be a positive number");
  }
  const plans: SegmentPlan[] = [];
  const total = Math.ceil(chunkCount / segmentChunks);
  for (let index = 0; index < total; index++) {
    const firstChunk = index * segmentChunks;
    const lastChunk = Math.min(firstChunk + segmentChunks - 1, chunkCount - 1);
    plans.push({ index, firstChunk, lastChunk });
  }
  return plans;
}

/**
 * Offset of the first WebM Cluster element (1F 43 B6 75) inside chunk 00000.
 * Everything before it is the init segment (EBML header + Segment + Info +
 * Tracks) that every later chunk lacks.
 *
 * Throws when no Cluster is present, and when the Cluster starts at byte 0
 * (that would mean the buffer carries no init segment at all).
 */
export function findInitBoundary(bytes: Uint8Array): number {
  const limit = bytes.length - CLUSTER_ID.length;
  for (let i = 0; i <= limit; i++) {
    if (
      bytes[i] === CLUSTER_ID[0] &&
      bytes[i + 1] === CLUSTER_ID[1] &&
      bytes[i + 2] === CLUSTER_ID[2] &&
      bytes[i + 3] === CLUSTER_ID[3]
    ) {
      if (i === 0) {
        throw new Error("WebM init boundary at offset 0: chunk carries no header");
      }
      return i;
    }
  }
  throw new Error("WebM init boundary not found: no Cluster element (1F 43 B6 75)");
}

/**
 * Offset of the LAST WebM Cluster element (1F 43 B6 75) inside a chunk.
 *
 * A chunk boundary cuts a Cluster in half (Chromium clusters are ~1 s, Safari
 * ~10 s), so the segment that STARTS at that boundary opens mid-SimpleBlock:
 * the demuxer reads a garbage length, logs "Truncating packet", invents a
 * phantom stream and drops that cluster's audio. Prepending
 * `chunk[first - 1].slice(findLeadBoundary(...))` — the head of exactly that
 * cut Cluster — makes the cluster whole again.
 *
 * Throws when no Cluster is present (nothing to lead with), and when the last
 * Cluster starts at byte 0 (the whole chunk would become the lead, i.e. up to
 * 30 s of duplicated audio). Callers treat both as "compose without a lead".
 */
export function findLeadBoundary(bytes: Uint8Array): number {
  for (let i = bytes.length - CLUSTER_ID.length; i >= 0; i--) {
    if (
      bytes[i] === CLUSTER_ID[0] &&
      bytes[i + 1] === CLUSTER_ID[1] &&
      bytes[i + 2] === CLUSTER_ID[2] &&
      bytes[i + 3] === CLUSTER_ID[3]
    ) {
      if (i === 0) {
        throw new Error("WebM lead boundary at offset 0: the whole chunk is one cluster");
      }
      return i;
    }
  }
  throw new Error("WebM lead boundary not found: no Cluster element (1F 43 B6 75)");
}

/** Wall-clock second at which segment `index` starts inside the meeting. */
export function segmentStartSeconds(
  index: number,
  segmentChunks: number = DEFAULT_SEGMENT_CHUNKS,
  chunkSeconds: number = DEFAULT_CHUNK_SECONDS,
): number {
  return index * segmentChunks * chunkSeconds;
}

/** 1800 -> "00:30:00". */
export function formatHMS(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * Stitch the per-segment texts into one transcript, in NUMERIC index order
 * (so "10" lands after "9"), each part introduced by its own time marker.
 */
export function joinTranscript(
  texts: Record<string, string>,
  total: number,
  segmentChunks: number = DEFAULT_SEGMENT_CHUNKS,
  chunkSeconds: number = DEFAULT_CHUNK_SECONDS,
): string {
  const parts: string[] = [];
  for (let i = 0; i < total; i++) {
    const text = texts?.[String(i)];
    if (!text || !text.trim()) continue;
    const marker = `--- ${formatHMS(segmentStartSeconds(i, segmentChunks, chunkSeconds))} ---`;
    parts.push(`${marker}\n${text.trim()}`);
  }
  return parts.join("\n\n");
}

/** Lowest segment index with no text yet, or null when every segment is in. */
export function firstMissingSegment(
  texts: Record<string, string> | null | undefined,
  total: number,
): number | null {
  for (let i = 0; i < total; i++) {
    const text = texts?.[String(i)];
    if (!text || !text.trim()) return i;
  }
  return null;
}

/** How many segments still have no text (what a worker reports as `remaining`). */
export function countMissingSegments(
  texts: Record<string, string> | null | undefined,
  total: number,
): number {
  let missing = 0;
  for (let i = 0; i < total; i++) {
    const text = texts?.[String(i)];
    if (!text || !text.trim()) missing++;
  }
  return missing;
}

/**
 * True only while a REAL lease exists and its `until` is still in the future.
 *
 * The released sentinel (segment -1, `until` at the epoch) is NOT valid, and a
 * negative segment is rejected whatever its `until` says: the sentinel means "no
 * worker holds this meeting", so it must never read as busy.
 */
export function leaseIsValid(
  lease: SegmentLease | null | undefined,
  nowMs: number,
): boolean {
  if (!lease || lease.until === null || lease.until === undefined) return false;
  if (typeof lease.segment === "number" && lease.segment < 0) return false;
  const until = typeof lease.until === "number"
    ? lease.until
    : Date.parse(String(lease.until));
  if (!Number.isFinite(until)) return false;
  return until > nowMs;
}

/**
 * Split focusos_meetings.recording_gcs_path into its bucket and recording folder.
 *
 * TWO shapes exist in production, both written by focusos-process-meeting:
 *   gs://<bucket>/<folder>/recording.webm      multi-chunk recordings (composed)
 *   gs://<bucket>/<folder>/chunks/00000.webm   chunk_count === 1, i.e. under
 *                                              ~30 s: compose is skipped and the
 *                                              single chunk IS the recording.
 * Returns null for anything else (a caller turns that into a readable error).
 */
export function parseRecordingPath(
  path: string | null | undefined,
): { bucket: string; folder: string } | null {
  const match = String(path ?? "").match(
    /^gs:\/\/([^/]+)\/(.+?)\/(?:recording\.[^/]+|chunks\/\d{5}\.webm)$/,
  );
  if (!match) return null;
  return { bucket: match[1], folder: match[2] };
}

/** GCS object name of chunk `i` inside a recording folder. */
export function chunkObjectName(folder: string, i: number): string {
  return `${folder}/chunks/${String(i).padStart(5, "0")}.webm`;
}

/** GCS object holding the EBML header shared by every segment after the first. */
export function initObjectName(folder: string): string {
  return `${folder}/init.webm`;
}

/** Prefix every composed segment and lead object lives under. */
export function segmentsPrefix(folder: string): string {
  return `${folder}/segments/`;
}

/** GCS object name of the composed segment `i`. */
export function segmentObjectName(folder: string, i: number): string {
  return `${segmentsPrefix(folder)}${String(i).padStart(2, "0")}.webm`;
}

/** GCS object name of segment `i`'s lead cluster (see findLeadBoundary). */
export function leadObjectName(folder: string, i: number): string {
  return `${segmentsPrefix(folder)}${String(i).padStart(2, "0")}-lead.webm`;
}

/**
 * The transcription prompt for ONE segment.
 *
 * The base wording is the app's original whole-file production prompt, kept
 * verbatim: a terser rewrite made Gemini answer looped speech with a single
 * sentence (evidence handoff/evidence/mt0/gemini-seg0-*.txt). Only the
 * part/offset sentence and the overlap sentence are added.
 */
export function buildSegmentPrompt(
  index: number,
  total: number,
  startHms: string,
  participantNames: string[],
  previousTail: string,
): string {
  const participantsLine = participantNames.length > 0
    ? ` The participants are: ${participantNames.join(", ")}. Label each speaker by their name where possible.`
    : " Include speaker diarization where possible (label speakers as Speaker 1, Speaker 2, etc.).";
  const tail = (previousTail ?? "").trim();
  const overlapLine = index > 0 && tail
    ? ` The first few seconds of this part overlap with the end of the previous part, which ended with: "${tail}". Do not repeat those words; continue from where the previous part ended and keep the same speaker labels.`
    : "";
  return `Transcribe this audio recording of a meeting. This is part ${index + 1} of ${total} of the recording; it starts at ${startHms} of the meeting.${participantsLine} Format the output as a clean transcript with speaker labels. Do not include timestamps. Transcribe every sentence that is spoken, even if a passage is repeated. Be thorough and accurate.${overlapLine}`;
}

/* ─── Gemini response shape (pure) ──────────────────────────────── */

/**
 * What a segment's text becomes when Gemini legitimately hears nothing in it.
 *
 * NON-BLANK on purpose: firstMissingSegment / countMissingSegments / joinTranscript
 * all treat a blank text as "this segment is not done yet", so a genuinely silent
 * 10 minutes stored as "" would be re-transcribed until the attempt budget ran
 * out and the whole meeting failed.
 */
export const NO_SPEECH_TEXT = "(no speech in this part)";

/**
 * Appended to a segment whose Gemini response hit the output-token cap. It is
 * part of the stored transcript on purpose: a reader must be able to see where
 * the words stop, and the join step keeps the marker in place.
 */
export const TRUNCATED_MARKER = "[transcript truncated: output limit]";

/**
 * Pull the transcript out of a Gemini generateContent response body (callers
 * check resp.ok first, so this only ever sees a 200 body).
 *
 *  - no candidates                      -> error (quota/safety block on the prompt)
 *  - MAX_TOKENS WITH text               -> that text + TRUNCATED_MARKER, and the
 *    segment counts as DONE: ten minutes of real transcript minus its tail beats
 *    three more identical calls that hit the same cap and fail the meeting.
 *  - MAX_TOKENS with NO text            -> error (nothing was heard at all)
 *  - any other non-STOP finishReason    -> error naming the reason (SAFETY /
 *    RECITATION: the response is not a transcript)
 *  - blank text with STOP / no reason   -> NO_SPEECH_TEXT (a silent stretch)
 *  - otherwise                          -> the joined part texts
 */
export function extractTranscriptText(
  responseJson: unknown,
): { text: string } | { error: string } {
  const data = (responseJson ?? {}) as Record<string, any>;
  const candidate = (data.candidates ?? [])[0];
  if (!candidate) {
    const blocked = data.promptFeedback?.blockReason;
    return {
      error: blocked
        ? `Gemini returned no candidates (blockReason ${blocked})`
        : "Gemini returned no candidates",
    };
  }

  const finishReason = candidate.finishReason ?? candidate.finish_reason ?? null;
  const isStop = finishReason === null || finishReason === undefined ||
    finishReason === "STOP" || finishReason === "FINISH_REASON_STOP" ||
    finishReason === "FINISH_REASON_UNSPECIFIED";
  const isMaxTokens = finishReason === "MAX_TOKENS" ||
    finishReason === "FINISH_REASON_MAX_TOKENS";
  if (!isStop && !isMaxTokens) {
    return { error: `Gemini stopped early (finishReason ${finishReason})` };
  }

  const parts = candidate.content?.parts;
  const text = Array.isArray(parts)
    ? parts.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("")
    : "";

  if (isMaxTokens) {
    // Keep what was heard, mark the cut, count the segment done.
    if (text.trim()) return { text: `${text}\n${TRUNCATED_MARKER}` };
    return { error: `Gemini stopped early (finishReason ${finishReason})` };
  }

  if (text.trim()) return { text };
  return { text: NO_SPEECH_TEXT };
}

/* ─── Container sniffing + secret scrubbing (pure) ──────────────── */

/** First four bytes of every WebM / Matroska file: EBML magic 1A 45 DF A3. */
const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];

/**
 * True only for a buffer that opens with the EBML magic. Browsers without
 * MediaRecorder WebM support record audio/mp4 instead ("....ftyp"), which the
 * init/lead cluster search cannot handle at all — callers fail fast on false.
 */
export function isWebm(bytes: Uint8Array | null | undefined): boolean {
  if (!bytes || bytes.length < EBML_MAGIC.length) return false;
  for (let i = 0; i < EBML_MAGIC.length; i++) {
    if (bytes[i] !== EBML_MAGIC[i]) return false;
  }
  return true;
}

/** Lowercase hex of the first n bytes, space separated: "1a 45 df a3". */
export function hexHead(bytes: Uint8Array | null | undefined, n = 4): string {
  if (!bytes || bytes.length === 0) return "(empty)";
  return Array.from(bytes.slice(0, n))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

/**
 * Make an error message safe to persist in processing_error (which the app
 * shows on the meeting card).
 *
 * A Deno fetch failure embeds the request URL, and every Gemini URL carries
 * `?key=<GEMINI_API_KEY>`; a Supabase failure can quote a service-role bearer.
 * Both are replaced by "***".
 */
export function scrubSecrets(
  message: unknown,
  secrets: (string | null | undefined)[] = [],
): string {
  let out = message instanceof Error ? message.message : String(message ?? "");
  out = out.replace(/key=[^&\s)"']+/g, "key=***");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8) {
      out = out.split(secret).join("***");
    }
  }
  return out;
}
