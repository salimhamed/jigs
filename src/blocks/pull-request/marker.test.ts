import { expect, test } from "vitest";
import {
  assertUsableScope,
  carriesMarker,
  commentSource,
  markBody,
  type PrMarker,
  parseMarkers,
  prScope,
  readLedger,
  renderMarker,
} from "./marker.ts";

const marker: PrMarker = {
  scope: "ship/AGE-123",
  run: "wrun_01M2EKJSDQHC87BCEYCAV4GVKJ",
  kind: "reply",
  source: "5657161233@2026-09-14T01:17:07Z",
};

test("renders one hidden line carrying a JSON object", () => {
  expect(renderMarker(marker)).toBe(
    '<!-- jigs:v1 {"scope":"ship/AGE-123","run":"wrun_01M2EKJSDQHC87BCEYCAV4GVKJ","kind":"reply","source":"5657161233@2026-09-14T01:17:07Z"} -->',
  );
});

test("a status marker says why it was written, and refuses to render without it", () => {
  expect(renderMarker({ scope: "s", run: "r", kind: "status", reason: "ci", source: "sha" })).toBe(
    '<!-- jigs:v1 {"scope":"s","run":"r","kind":"status","reason":"ci","source":"sha"} -->',
  );
  expect(() => renderMarker({ scope: "s", run: "r", kind: "status" })).toThrow("why");
});

test("a reply that answers nothing nameable still carries a marker", () => {
  expect(renderMarker({ scope: "s", run: "r", kind: "reply" })).toBe(
    '<!-- jigs:v1 {"scope":"s","run":"r","kind":"reply"} -->',
  );
  // Posting an unmarked comment would have jigs answering itself next wake.
  expect(() => markBody("no marker", [])).toThrow("carries a marker");
});

test("a quoted marker is a quotation, not jigs' own words", () => {
  const quoted = [
    "> Renamed the function.",
    ">",
    `> ${renderMarker(marker)}`,
    "",
    "What about the caller?",
  ].join("\n");
  expect(parseMarkers(quoted)).toEqual([]);
  expect(carriesMarker(quoted)).toBe(false);
  // Indented quoting, as GitHub emits inside a list, reads the same way.
  expect(carriesMarker(`  > ${renderMarker(marker)}`)).toBe(false);
  // And the marker still counts where it is not quoted.
  expect(carriesMarker(`${quoted}\n\n${renderMarker(marker)}`)).toBe(true);
});

test("round-trips a value carrying quotes, angle brackets and newlines", () => {
  const awkward: PrMarker = {
    scope: 'review "outstanding" 100% <b>\nnow',
    run: "wrun_1",
    kind: "completion",
    source: "a--b",
  };
  const rendered = renderMarker(awkward);
  // JSON does the escaping, so the marker is still one line and the only
  // `-->` in it is the terminator.
  expect(rendered.split("\n")).toHaveLength(1);
  expect(rendered.indexOf("-->")).toBe(rendered.length - 3);
  expect(parseMarkers(rendered)).toEqual([awkward]);
});

test("the one sequence a value may not carry is the comment terminator", () => {
  expect(() => renderMarker({ scope: "a-->b", run: "r", kind: "reply" })).toThrow('"-->"');
  expect(() => renderMarker({ scope: "s", run: "r", kind: "reply", source: "a-->b" })).toThrow(
    '"-->"',
  );
  expect(() => assertUsableScope("")).toThrow("empty");
  // The scope is the only value a caller supplies, so it is checked where it
  // enters rather than where it breaks a comment open.
  expect(() => prScope("ship", "a-->b")).toThrow('"-->"');
});

test("reads several markers out of one body and ignores the prose around them", () => {
  const body = markBody("Fixed, and here is why.", [
    marker,
    { ...marker, source: "99@2026-09-14T02:00:00Z" },
  ]);
  expect(body.startsWith("Fixed, and here is why.\n\n")).toBe(true);
  expect(parseMarkers(body).map((found) => found.source)).toEqual([
    "5657161233@2026-09-14T01:17:07Z",
    "99@2026-09-14T02:00:00Z",
  ]);
});

test("a body with no marker, or a malformed one, is nobody's work", () => {
  expect(carriesMarker("Please rename this")).toBe(false);
  // Not JSON at all, and JSON that is not an object.
  expect(carriesMarker("<!-- jigs:v1 scope=s kind=reply -->")).toBe(false);
  expect(carriesMarker('<!-- jigs:v1 "reply" -->')).toBe(false);
  // Missing or unknown where it matters.
  expect(carriesMarker('<!-- jigs:v1 {"kind":"reply"} -->')).toBe(false);
  expect(carriesMarker('<!-- jigs:v1 {"scope":"s","kind":"shout"} -->')).toBe(false);
  expect(carriesMarker('<!-- jigs:v1 {"scope":"s","kind":"status","source":"x"} -->')).toBe(false);
  expect(carriesMarker('<!-- jigs:v1 {"scope":"s","kind":"reply"} -->')).toBe(true);
  // A field this version does not know is left alone rather than refused.
  expect(parseMarkers('<!-- jigs:v1 {"scope":"s","kind":"reply","future":1} -->')).toEqual([
    { scope: "s", run: "", kind: "reply" },
  ]);
});

test("the ledger holds only this scope's work, split by what the kind proves", () => {
  const bodies = [
    markBody("answered", [{ scope: "ship/A", run: "r", kind: "reply", source: "1@t" }]),
    markBody("committed", [{ scope: "ship/A", run: "r", kind: "completion", source: "sha1" }]),
    markBody("no merge", [
      { scope: "ship/A", run: "r", kind: "status", reason: "merge", source: "sha2" },
    ]),
    markBody("no repair", [
      { scope: "ship/A", run: "r", kind: "status", reason: "ci", source: "sha3" },
    ]),
    markBody("another workflow", [{ scope: "review/A", run: "r", kind: "reply", source: "2@t" }]),
  ];
  const ledger = readLedger(bodies, "ship/A");
  expect([...ledger.answered]).toEqual(["1@t", "sha1"]);
  // A merge jigs could not make says nothing about that commit's checks.
  expect([...ledger.settled.merge]).toEqual(["sha2"]);
  expect([...ledger.settled.ci]).toEqual(["sha3"]);
  expect(readLedger(bodies, "review/A").answered.has("1@t")).toBe(false);
});

test("a comment's source changes when it is edited", () => {
  expect(commentSource({ id: 7, updatedAt: "2026-09-14T01:00:00Z" })).toBe(
    "7@2026-09-14T01:00:00Z",
  );
  expect(commentSource({ id: 7, updatedAt: "2026-09-14T02:00:00Z" })).not.toBe(
    commentSource({ id: 7, updatedAt: "2026-09-14T01:00:00Z" }),
  );
});

test("the default scope names the workflow and its subject", () => {
  expect(prScope("ship", "AGE-123")).toBe("ship/AGE-123");
});
