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
