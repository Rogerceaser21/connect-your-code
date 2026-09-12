# Retune meeting-transcription worker timing to the 150 s gateway ceiling

## Goal
Fix the silent-stall failure diagnosed on 2026-09-11 (isolate killed at exec 151,447 ms; a late-started segment's 300 s lease outlives every worker, costing ~5.5 min before the watchdog resumes). Centralize all timing constants in one shared module and resize them against the gateway's ~150 s request kill, not the 400 s wall clock.

## BLOCKER — required before execution
Your message included the full verbatim content of `_shared/timing.ts` only. The other four files were represented by the marker `PLACEHOLDER_REMAINING_FILES` — their contents were not delivered:

1. `supabase/functions/_shared/timing_test.ts`
2. `supabase/functions/_shared/gemini.ts`
3. `supabase/functions/_shared/gcs.ts`
4. `supabase/functions/focusos-transcribe-meeting/index.ts`

Since the instruction is byte-for-byte verbatim replacement with no reformatting, I will not derive or reconstruct these files myself. Send the four file bodies (a follow-up message with the BEGIN/END blocks is fine) and this plan proceeds unchanged. If you'd rather I generate them from the current sources with the stated cap changes (imports from `timing.ts`, constants retuned, budget/finalize gates per `canStartSegment`/`canFinalize`), say so explicitly — that deviates from "verbatim" and I'll note it in the commit.

## Current state (verified by reading the repo)
- `focusos-transcribe-meeting/index.ts`: `LEASE_MS = 300_000`, `BUDGET_MS = 60_000`, `WALL_CLOCK_MS = 400_000`-style logic with `FINALIZE_RESERVE_MS = 150_000`; segment start gate at `elapsed >= BUDGET_MS`; finalize gate at `spentMs > WALL_CLOCK_MS - FINALIZE_RESERVE_MS`.
- `_shared/gemini.ts`: `UPLOAD_TIMEOUT_MS = 60_000`, `GENERATE_TIMEOUT_MS = 120_000`, ACTIVE wait unbounded-by-shared-constant; summary call shares `GENERATE_TIMEOUT_MS`.
- `_shared/gcs.ts`: `GCS_TIMEOUT_MS = 60_000`.
- `_shared/` currently contains `gcs.ts`, `gemini.ts`, `segments.ts` — no `timing.ts`, no test file.

## What changes
| Constant | From | To |
|---|---|---|
| Gemini upload cap | 60 s | 30 s |
| Gemini file ACTIVE wait cap | 60 s | 20 s |
| generateContent cap (transcribe + summary) | 120 s | 60 s |
| GCS leg cap | 60 s | 30 s |
| Segment-start budget | 60 s | 30 s (`canStartSegment`) |
| Finalize begin gate | 400 s − 150 s reserve | 60 s (`canFinalize`, else self-kick handover) |
| Lease TTL | 300 s | 150 s |
| Poller stale check | 180 s | unchanged |

## Steps
1. Receive the four missing file bodies (see BLOCKER).
2. Create `supabase/functions/_shared/timing.ts` with the exact content supplied (already in hand).
3. Create `supabase/functions/_shared/timing_test.ts` verbatim (repo-only, not deployed).
4. Replace `_shared/gemini.ts`, `_shared/gcs.ts`, `focusos-transcribe-meeting/index.ts` verbatim.
5. Deploy exactly two functions: `focusos-transcribe-meeting`, `focusos-poll-stuck-meetings` (unchanged source, redeployed to pick up new shared caps).
6. Verify: `POST` with `{}` returns HTTP 400 `{"error":"Missing meetingId"}`; deployed transcribe bundle carries `LEASE_MS = 150_000` / `BUDGET_MS = 30_000`; poller still logs `still leased` for live leases and resumes expired ones.

## Out of scope
No migration, no `src/` change, no types regeneration, no secret/RLS/table/trigger changes. `focusos-process-meeting` and `focusos-mcp` are not redeployed (they keep their older bundled shared modules — harmless). The main commit contains exactly the five files listed.

## Technical details
- `_shared/timing.ts` exports `GATEWAY_KILL_MS=150_000`, `GCS_TIMEOUT_MS=30_000`, `UPLOAD_TIMEOUT_MS=30_000`, `FILE_ACTIVE_CAP_MS=20_000`, `GENERATE_TIMEOUT_MS=60_000`, `BUDGET_MS=30_000`, `FINALIZE_BY_MS=60_000`, `LEASE_MS=150_000`, plus `canStartSegment`, `canFinalize`, `worstCaseSegmentMs`.
- Rationale: a segment started near the budget edge can run past the gateway kill; the 150 s lease then expires roughly when the isolate dies, letting the next worker/poller take over promptly. Correctness still rests on token-owned writes, not the lease.
- The known worst-case segment path intentionally exceeds 150 s; the common case finishes inside one request, and the pathological case is covered by lease expiry + the unchanged 180 s poller check.

## Risks
- Redeploying `focusos-poll-stuck-meetings` re-bundles `gemini.ts`/`gcs.ts` with tighter caps — matches your instruction; the poller's own logic is untouched.
- Tighter per-leg caps (30 s GCS/upload) could abort slow-but-viable transfers on poor network; acceptable per the supplied design, and token-owned retries make an aborted leg safe.
