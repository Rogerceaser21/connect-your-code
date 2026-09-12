import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  BUDGET_MS,
  canFinalize,
  canStartSegment,
  FILE_ACTIVE_CAP_MS,
  FINALIZE_BY_MS,
  GATEWAY_KILL_MS,
  GCS_TIMEOUT_MS,
  GENERATE_TIMEOUT_MS,
  LEASE_MS,
  UPLOAD_TIMEOUT_MS,
  worstCaseSegmentMs,
} from "./timing.ts";

Deno.test("canStartSegment: a segment may start at 29_999 ms but not at 30_000 ms", () => {
  assertEquals(canStartSegment(29_999), true);
  assertEquals(canStartSegment(30_000), false);
});

Deno.test("canStartSegment: the boundary IS BUDGET_MS", () => {
  assertEquals(BUDGET_MS, 30_000);
  assertEquals(canStartSegment(BUDGET_MS - 1), true);
  assertEquals(canStartSegment(BUDGET_MS), false);
});

Deno.test("canFinalize: finalize may begin at 60_000 ms but not at 60_001 ms", () => {
  assertEquals(canFinalize(60_000), true);
  assertEquals(canFinalize(60_001), false);
});

Deno.test("canFinalize: the boundary IS FINALIZE_BY_MS", () => {
  assertEquals(FINALIZE_BY_MS, 60_000);
  assertEquals(canFinalize(FINALIZE_BY_MS), true);
  assertEquals(canFinalize(FINALIZE_BY_MS + 1), false);
});

Deno.test("LEASE_MS is the 150 s gateway ceiling, not the 400 s function limit", () => {
  assertEquals(LEASE_MS, 150_000);
  assertEquals(LEASE_MS, GATEWAY_KILL_MS);
});

Deno.test("per-leg caps are the MT7 values", () => {
  assertEquals(GCS_TIMEOUT_MS, 30_000);
  assertEquals(UPLOAD_TIMEOUT_MS, 30_000);
  assertEquals(FILE_ACTIVE_CAP_MS, 20_000);
  assertEquals(GENERATE_TIMEOUT_MS, 60_000); // transcription AND summary call
});

Deno.test("RESIDUAL, stated not hidden: one worst-case segment can be killed by the gateway", () => {
  // 30 compose + 30 upload + 20 ACTIVE + 60 generate + 2x30 (init + lead writes).
  const worst = worstCaseSegmentMs();
  assertEquals(worst, 200_000);

  // A segment may START at BUDGET_MS - 1 (just under 30 s) and then run a full
  // worst-case chain, so this is the latest a request that started its last
  // segment at the budget edge could still be working.
  const latestPossible = BUDGET_MS + worst;
  assertEquals(latestPossible, 230_000);

  // That sum EXCEEDS the 150 s gateway kill ON PURPOSE. MT7 does not try to fit
  // the pathological worst case inside one request: a segment cut off by the
  // gateway is covered by LEASE_MS (expires ~when the isolate dies) and the
  // poller's 180 s stale check, and no work is corrupted because every state
  // write is token-owned. The COMMON case (a segment well under these caps) does
  // finish inside 150 s; the residual below is the price of that safety net, and
  // it is asserted here rather than left unsaid.
  const residualOverGateway = latestPossible - GATEWAY_KILL_MS;
  assertEquals(residualOverGateway, 80_000);
  assertEquals(residualOverGateway > 0, true);
});
