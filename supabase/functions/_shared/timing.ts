/**
 * The meeting-transcription worker's timing budget, in ONE place so the numbers
 * that decide when a request may start a segment or finalize are the SAME numbers
 * the segment chain's time-boxed legs are sized against — and so a unit test can
 * pin them (timing_test.ts).
 *
 * THE CEILING IS THE GATEWAY, NOT THE FUNCTION. The Supabase edge gateway has a
 * hard ~150 s REQUEST timeout that kills the whole isolate (a 504 with `shutdown`
 * logged in the same instant), regardless of the platform's advertised function
 * wall clock (400 s on Pro). In-flight work cannot outlive ~150 s from request
 * start. Every budget here is sized against GATEWAY_KILL_MS, never against the
 * 400 s figure. Live-proved 2026-09-11 (MT4 log pull: isolate killed at
 * exec_ms 151447). See memory focusos-meeting-transcription-pipeline.
 */

/** The hard ceiling: the gateway kills the isolate at ~150 s from request start. */
export const GATEWAY_KILL_MS = 150_000;

/* ── Per-leg caps: the time-box on each external call inside one segment ──────
 * These ARE the values gcs.ts and gemini.ts abort their fetches at (both import
 * them from here), so worstCaseSegmentMs() below sums the caps the code really
 * uses — the number cannot drift away from the behaviour. */

/** Every GCS leg (token, upload, list, compose, download, delete). */
export const GCS_TIMEOUT_MS = 30_000;
/** The WHOLE GCS -> Gemini File API transfer (metadata + init + every PUT). */
export const UPLOAD_TIMEOUT_MS = 30_000;
/** Waiting for a just-uploaded Gemini file to report ACTIVE. */
export const FILE_ACTIVE_CAP_MS = 20_000;
/** One generateContent call — the transcription AND the summary call use this. */
export const GENERATE_TIMEOUT_MS = 60_000;

/* ── Worker budget ───────────────────────────────────────────────────────── */

/**
 * Stop STARTING new segments once this much of the request's wall clock is gone.
 * A segment may start at BUDGET_MS - epsilon and then run a full
 * worstCaseSegmentMs() chain, so BUDGET_MS is deliberately well under
 * GATEWAY_KILL_MS — the request that starts a segment at the budget edge is the
 * one the lease + poller safety net is there for (see worstCaseSegmentMs).
 */
export const BUDGET_MS = 30_000;

/**
 * Begin finalize (summary call + transcript upload + artifact cleanup) only while
 * elapsed is still within this. Past it, hand the finalize to a fresh worker with
 * a full budget rather than be cut off mid-summary by the gateway kill.
 */
export const FINALIZE_BY_MS = 60_000;

/**
 * How long a taken lease is held. Sized to the gateway kill: a request cannot
 * live past ~GATEWAY_KILL_MS, so a longer lease would outlive every worker that
 * could hold it and stall the meeting until the poller's 180 s stale check.
 * Correctness never rests on the lease alone — every state write is token-owned,
 * so an expired owner stands down and at most one segment's Gemini call repeats —
 * but a lease that expires roughly when the isolate dies lets the next worker (or
 * the poller) take a killed segment over promptly.
 */
export const LEASE_MS = 150_000;

/** True only while a new segment may still be STARTED (elapsed < BUDGET_MS). */
export function canStartSegment(elapsedMs: number): boolean {
  return elapsedMs < BUDGET_MS;
}

/** True only while finalize may still BEGIN in this request (elapsed <= FINALIZE_BY_MS). */
export function canFinalize(elapsedMs: number): boolean {
  return elapsedMs <= FINALIZE_BY_MS;
}

/**
 * The worst-case wall time of ONE segment's chain of time-boxed legs, summed from
 * the per-leg caps above. The heaviest path is a later segment (i > 0) whose
 * init.webm still has to be built:
 *   - compose leg (GCS)                 GCS_TIMEOUT_MS
 *   - GCS -> Gemini upload              UPLOAD_TIMEOUT_MS
 *   - ACTIVE wait                       FILE_ACTIVE_CAP_MS
 *   - generateContent                   GENERATE_TIMEOUT_MS
 *   - init.webm + lead-cluster writes   2 x GCS_TIMEOUT_MS  (the GCS write legs)
 *
 * The pre-write GCS *reads* that feed those writes (chunk 0 for the init header,
 * the previous chunk for the lead cluster) are further GCS_TIMEOUT_MS legs on top
 * of this; they only make the number LARGER, so they are called out here rather
 * than folded in silently. The token-owned DB PATCHes and the best-effort Gemini
 * file delete are not counted — they are not the ceiling.
 *
 * This sum EXCEEDS GATEWAY_KILL_MS on purpose: MT7 does not try to fit the
 * pathological worst case inside one request. A segment cut off by the gateway is
 * covered by LEASE_MS (which expires roughly when the isolate dies) and the
 * poller's stale check, with no corruption because every write is token-owned.
 * The COMMON case — a segment well under these caps — finishes inside 150 s.
 */
export function worstCaseSegmentMs(): number {
  const gcsWriteLegs = 2; // init.webm + lead cluster
  return (
    GCS_TIMEOUT_MS + // compose
    UPLOAD_TIMEOUT_MS + // Gemini upload
    FILE_ACTIVE_CAP_MS + // ACTIVE wait
    GENERATE_TIMEOUT_MS + // generateContent
    gcsWriteLegs * GCS_TIMEOUT_MS // init + lead writes
  );
}
