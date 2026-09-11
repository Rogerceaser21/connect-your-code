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

/** The lease a worker takes while it transcribes one segment. */
export interface SegmentLease {
  segment: number;
  /** ISO timestamp (or epoch ms) after which the lease is dead. */
  until: string | number;
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
  lease: SegmentLease | null;
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

/** True only while a lease exists and its `until` is still in the future. */
export function leaseIsValid(
  lease: SegmentLease | null | undefined,
  nowMs: number,
): boolean {
  if (!lease || lease.until === null || lease.until === undefined) return false;
  const until = typeof lease.until === "number"
    ? lease.until
    : Date.parse(String(lease.until));
  if (!Number.isFinite(until)) return false;
  return until > nowMs;
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
