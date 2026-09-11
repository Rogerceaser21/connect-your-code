import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  chunkObjectName,
  findInitBoundary,
  firstMissingSegment,
  formatHMS,
  joinTranscript,
  leaseIsValid,
  planSegments,
  segmentStartSeconds,
} from "./segments.ts";

Deno.test("planSegments: 157 chunks -> 8 segments, last is 140..156", () => {
  const plans = planSegments(157);
  assertEquals(plans.length, 8);
  assertEquals(plans[0], { index: 0, firstChunk: 0, lastChunk: 19 });
  assertEquals(plans[7], { index: 7, firstChunk: 140, lastChunk: 156 });
  assertEquals(plans[7].lastChunk - plans[7].firstChunk + 1, 17);
});

Deno.test("planSegments: exact multiple and one-over", () => {
  assertEquals(planSegments(20).length, 1);
  assertEquals(planSegments(20)[0], { index: 0, firstChunk: 0, lastChunk: 19 });
  assertEquals(planSegments(21).length, 2);
  assertEquals(planSegments(21)[1], { index: 1, firstChunk: 20, lastChunk: 20 });
});

Deno.test("planSegments: zero chunks -> no segments", () => {
  assertEquals(planSegments(0).length, 0);
});

Deno.test("findInitBoundary: returns the offset of the first Cluster id", () => {
  const header = [0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06];
  const bytes = new Uint8Array([...header, 0x1f, 0x43, 0xb6, 0x75, 0xaa, 0xbb]);
  assertEquals(findInitBoundary(bytes), header.length);
});

Deno.test("findInitBoundary: takes the FIRST cluster when several exist", () => {
  const bytes = new Uint8Array([
    0x1a, 0x45, 0xdf, 0xa3,
    0x1f, 0x43, 0xb6, 0x75,
    0x00, 0x00,
    0x1f, 0x43, 0xb6, 0x75,
  ]);
  assertEquals(findInitBoundary(bytes), 4);
});

Deno.test("findInitBoundary: throws when absent", () => {
  const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x11, 0x22]);
  assertThrows(() => findInitBoundary(bytes), Error, "not found");
});

Deno.test("findInitBoundary: throws when the cluster is at offset 0", () => {
  const bytes = new Uint8Array([0x1f, 0x43, 0xb6, 0x75, 0x00, 0x11]);
  assertThrows(() => findInitBoundary(bytes), Error, "offset 0");
});

Deno.test("segmentStartSeconds + formatHMS", () => {
  assertEquals(segmentStartSeconds(0), 0);
  assertEquals(segmentStartSeconds(3), 1800);
  assertEquals(formatHMS(0), "00:00:00");
  assertEquals(formatHMS(1800), "00:30:00");
  assertEquals(formatHMS(4671), "01:17:51");
});

Deno.test("joinTranscript: numeric order (10 after 9) with time markers", () => {
  const texts: Record<string, string> = {};
  for (let i = 0; i < 11; i++) texts[String(i)] = `part ${i}`;
  const joined = joinTranscript(texts, 11);
  assertEquals(joined.indexOf("part 9") < joined.indexOf("part 10"), true);
  assertEquals(joined.startsWith("--- 00:00:00 ---\npart 0"), true);
  assertEquals(joined.includes("\n\n--- 00:10:00 ---\npart 1"), true);
  assertEquals(joined.includes("--- 01:40:00 ---\npart 10"), true);
});

Deno.test("joinTranscript: skips empty parts, keeps blank line between parts", () => {
  const joined = joinTranscript({ "0": "a", "1": "   ", "2": "c" }, 3);
  assertEquals(joined, "--- 00:00:00 ---\na\n\n--- 00:20:00 ---\nc");
});

Deno.test("firstMissingSegment: finds a hole in the middle", () => {
  assertEquals(firstMissingSegment({ "0": "a", "2": "c" }, 3), 1);
  assertEquals(firstMissingSegment({ "0": "a", "1": "b", "2": "c" }, 3), null);
  assertEquals(firstMissingSegment({}, 3), 0);
  assertEquals(firstMissingSegment({ "0": "a", "1": "", "2": "c" }, 3), 1);
  assertEquals(firstMissingSegment(null, 2), 0);
});

Deno.test("leaseIsValid: null, past and future", () => {
  const now = Date.UTC(2026, 8, 11, 12, 0, 0);
  assertEquals(leaseIsValid(null, now), false);
  assertEquals(leaseIsValid(undefined, now), false);
  assertEquals(
    leaseIsValid({ segment: 0, until: new Date(now - 1000).toISOString() }, now),
    false,
  );
  assertEquals(
    leaseIsValid({ segment: 0, until: new Date(now + 180_000).toISOString() }, now),
    true,
  );
  assertEquals(leaseIsValid({ segment: 0, until: now + 5 }, now), true);
  assertEquals(leaseIsValid({ segment: 0, until: "not-a-date" }, now), false);
});

Deno.test("chunkObjectName: 5-digit zero padding", () => {
  assertEquals(chunkObjectName("user/ts", 0), "user/ts/chunks/00000.webm");
  assertEquals(chunkObjectName("user/ts", 156), "user/ts/chunks/00156.webm");
});
