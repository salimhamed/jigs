import { expect, test } from "vitest";
import { interpolate } from "./interpolate.ts";

test("a known key is replaced and an unknown key is left verbatim", () => {
  expect(interpolate("{{TITLE}} — {{MISSING}}", { TITLE: "AGE-313" })).toBe(
    "AGE-313 — {{MISSING}}",
  );
});

test("a substituted value containing {{OTHER}} is not re-scanned", () => {
  const out = interpolate("{{TICKET}}", {
    TICKET: "the ticket body mentions {{OTHER}}",
    OTHER: "should never appear",
  });
  expect(out).toBe("the ticket body mentions {{OTHER}}");
});

test("a value containing shell-block syntax is inserted as plain text", () => {
  const out = interpolate("{{TICKET}}", { TICKET: "run !`rm -rf /` please" });
  expect(out).toBe("run !`rm -rf /` please");
});

test("whitespace inside the braces is tolerated", () => {
  expect(interpolate("{{ TITLE }}", { TITLE: "spaced" })).toBe("spaced");
});

test("a template with no placeholders is returned unchanged", () => {
  const template = "plain markdown with { braces } and $dollars";
  expect(interpolate(template, { TITLE: "unused" })).toBe(template);
});

test("an inherited property name is not a known key", () => {
  expect(interpolate("{{toString}}", {})).toBe("{{toString}}");
});
