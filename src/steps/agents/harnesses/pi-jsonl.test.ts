import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { reducePiJsonl } from "./pi-jsonl.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("plain pi JSONL reduces the authoritative final message and exposes deltas", () => {
  const onDelta = vi.fn();
  const generation = reducePiJsonl(fixture("pi-plain.jsonl"), onDelta);

  expect(generation).toEqual({
    text: "Hello world",
    providerMetadata: { pi: { sessionId: "session-plain" } },
  });
  expect(onDelta).toHaveBeenCalledTimes(2);
  expect(onDelta).toHaveBeenNthCalledWith(1, {
    type: "text_delta",
    contentIndex: 0,
    delta: "Hello",
  });
});

test("submit_result arguments become the structured generation output", () => {
  expect(reducePiJsonl(fixture("pi-submit-result.jsonl"))).toMatchObject({
    text: "",
    output: { word: "sky", count: 3 },
    providerMetadata: { pi: { sessionId: "session-submit" } },
  });
});

test("a message_end error fails even though pi exits zero", () => {
  expect(() => reducePiJsonl(fixture("pi-error.jsonl"))).toThrow(
    "model server rejected the request",
  );
});

test("a child stream without an assistant message_end is not a successful generation", () => {
  expect(() => reducePiJsonl('{"type":"session","id":"unfinished"}\n')).toThrow(
    "without an assistant message_end",
  );
});
