# Retune meeting-transcription timing to the 150 s gateway ceiling (MT7)

## Goal
The segmented transcription worker still sizes its budgets against a 400 s wall clock, but the Supabase edge gateway kills the isolate at ~150 s from request start (proved 2026-09-11: 504 at exec 151,447 ms with `shutdown` 0.12 s earlier). A segment started late in a request gets killed mid-flight, and its 300 s lease then outlives every possible worker — costing ~5.5 minutes before the watchdog resumes it. This centralizes every timing constant in one shared module and resizes them all against the real gateway ceiling.

## Verified current state
- `focusos-transcribe-meeting/index.ts`: `LEASE_MS = 300_000`, `BUDGET_MS = 60_000`, `FINALIZE_RESERVE_MS = 150_000` against a 400 s wall clock; segment gate is `elapsed >= BUDGET_MS`, finalize gate is `spentMs > WALL_CLOCK_MS - FINALIZE_RESERVE_MS`.
- `_shared/gemini.ts`: local `UPLOAD_TIMEOUT_MS = 60_000`, `GENERATE_TIMEOUT_MS = 120_000`; ACTIVE wait has a soft loop-top check only.
- `_shared/gcs.ts`: local `GCS_TIMEOUT_MS = 60_000`.
- `_shared/` holds `gcs.ts`, `gemini.ts`, `segments.ts` — no `timing.ts`, no test file.
- `focusos-poll-stuck-meetings/index.ts`: `STUCK_AFTER_SECONDS = 180` and the `still leased — leaving it` log both already present; this file is not edited.

## What changes
| Value | From | To |
|---|---|---|
| Gemini upload cap | 60 s | 30 s |
| Gemini file ACTIVE wait cap | 60 s | 20 s (now hard-bounded, not soft) |
| generateContent cap (transcribe + summary) | 120 s | 60 s |
| GCS leg cap | 60 s | 30 s |
| Segment-start gate | elapsed < 60 s | elapsed < 30 s (`canStartSegment`) |
| Finalize begin gate | 400 s − 150 s reserve | elapsed <= 60 s (`canFinalize`), else self-kick handover |
| Lease TTL | 300 s | 150 s |
| Poller stale check | 180 s | unchanged |

## Steps
1. Create `supabase/functions/_shared/timing.ts` verbatim — the single home for `GATEWAY_KILL_MS`, the per-leg caps, `BUDGET_MS`, `FINALIZE_BY_MS`, `LEASE_MS`, `canStartSegment`, `canFinalize`, `worstCaseSegmentMs`.
2. Create `supabase/functions/_shared/timing_test.ts` verbatim — Deno unit tests pinning every boundary and asserting the stated 80 s residual. Repo-only, never deployed.
3. Replace `supabase/functions/_shared/gemini.ts` verbatim — imports its caps from `timing.ts`, keeps `STATUS_TIMEOUT_MS`/`DELETE_TIMEOUT_MS` local, and hard-clamps both the per-poll fetch timeout and the inter-poll sleep to what remains of the ACTIVE-wait cap.
4. Replace `supabase/functions/_shared/gcs.ts` verbatim — imports and re-exports `GCS_TIMEOUT_MS` from `timing.ts` so existing importers keep working.
5. Replace `supabase/functions/focusos-transcribe-meeting/index.ts` verbatim — imports `BUDGET_MS`, `canFinalize`, `canStartSegment`, `FILE_ACTIVE_CAP_MS`, `LEASE_MS` from `timing.ts` and uses the two predicates at the segment-start and finalize decision points.
6. Deploy exactly two functions: `focusos-transcribe-meeting` (source changed) and `focusos-poll-stuck-meetings` (source unchanged, redeployed so its bundle picks up the new shared caps).
7. Verify acceptance: `POST` with `{}` returns HTTP 400 `{"error":"Missing meetingId"}`; the deployed transcribe source carries `LEASE_MS = 150_000` and `BUDGET_MS = 30_000` via `timing.ts`; confirm the poller's `still leased` path and 180 s stale check are untouched; confirm the commit contains exactly the five files.

## Out of scope
No migration. No `src/` change and no `src/integrations/supabase/types.ts` regeneration (no schema change). No secret, RLS policy, table or trigger change. No UI file, including `src/pages/Meetings.tsx`. `focusos-process-meeting` and `focusos-mcp` are not redeployed — they keep their older bundled copy of the shared modules until their next deploy, which is harmless.

## Technical notes
- Every leg cap the code aborts at now lives in the same module the budget predicates live in, so `worstCaseSegmentMs()` sums the caps the code really uses and cannot drift from behaviour.
- `worstCaseSegmentMs()` is 200 s and `BUDGET_MS + worst` is 230 s — deliberately over the 150 s gateway kill. This is stated, not hidden: a segment cut off by the gateway is covered by the 150 s lease (expiring roughly when the isolate dies) plus the 180 s poller check, with no corruption because every state write is token-owned. The common case finishes well inside one request.
- The finalize handover uses the worker's existing fire-and-forget `kickSelf`, so a fresh request gets a full 150 s gateway clock for the summary call and transcript upload.

## Risks
- Tighter 30 s GCS/upload caps could abort a slow-but-viable transfer on a poor network; token-owned writes make an aborted leg safe to repeat, at the cost of one repeated Gemini call at most.
- Redeploying the poller re-bundles the tightened shared caps; its own logic and thresholds are unchanged.
