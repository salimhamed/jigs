import { Output, streamText, wrapLanguageModel } from "ai";
import {
  convertArrayToReadableStream,
  convertReadableStreamToArray,
  MockLanguageModelV4,
} from "ai/test";
import { expect, test } from "vitest";
import { z } from "zod";
import { acceptedStructuredAnswer } from "./structured-output.ts";

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

// The shape the adapter streams when Claude Code rejects the first
// StructuredOutput submission and accepts the second.
const retriedAnswer: StreamPart[] = [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: '{"a":' },
  { type: "text-delta", id: "t1", delta: '"None"}' },
  { type: "text-end", id: "t1" },
  { type: "raw", rawValue: { type: "user" } },
  { type: "text-start", id: "t2" },
  { type: "text-delta", id: "t2", delta: '{"a":null}' },
  { type: "text-end", id: "t2" },
  { type: "finish", finishReason: { unified: "stop", raw: "success" }, usage },
];

const json = { type: "json", schema: { type: "object" } } as const;

function wrapped(parts: StreamPart[]) {
  return wrapLanguageModel({
    model: new MockLanguageModelV4({
      doStream: async () => ({ stream: convertArrayToReadableStream(parts) }),
    }),
    middleware: acceptedStructuredAnswer,
  });
}

test("a JSON stream keeps only the accepted submission and every other part in order", async () => {
  const { stream } = await wrapped(retriedAnswer).doStream({ prompt: [], responseFormat: json });

  expect(await convertReadableStreamToArray(stream)).toEqual([
    { type: "stream-start", warnings: [] },
    { type: "raw", rawValue: { type: "user" } },
    { type: "text-start", id: "t2" },
    { type: "text-delta", id: "t2", delta: '{"a":null}' },
    { type: "text-end", id: "t2" },
    retriedAnswer.at(-1),
  ]);
});

test("a text stream passes through untouched", async () => {
  const { stream } = await wrapped(retriedAnswer).doStream({ prompt: [] });

  expect(await convertReadableStreamToArray(stream)).toEqual(retriedAnswer);
});

test("a JSON stream without text forwards its finish alone", async () => {
  const parts = [retriedAnswer[0], retriedAnswer.at(-1)] as StreamPart[];
  const { stream } = await wrapped(parts).doStream({ prompt: [], responseFormat: json });

  expect(await convertReadableStreamToArray(stream)).toEqual(parts);
});

test("a JSON stream that fails drops the rejected submissions", async () => {
  const error = { type: "error", error: new Error("max structured output retries") } as const;
  const parts = [...retriedAnswer.slice(0, 5), error] as StreamPart[];
  const { stream } = await wrapped(parts).doStream({ prompt: [], responseFormat: json });

  expect(await convertReadableStreamToArray(stream)).toEqual([retriedAnswer[0], error]);
});

test("streamText reads the structured output from the accepted submission", async () => {
  const result = streamText({
    model: wrapped(retriedAnswer),
    prompt: "answer",
    output: Output.object({ schema: z.object({ a: z.null() }) }),
  });

  await expect(result.output).resolves.toEqual({ a: null });
});

test("without the middleware the joined submissions do not parse", async () => {
  const result = streamText({
    model: new MockLanguageModelV4({
      doStream: async () => ({ stream: convertArrayToReadableStream(retriedAnswer) }),
    }),
    prompt: "answer",
    output: Output.object({ schema: z.object({ a: z.null() }) }),
  });

  await expect(result.output).rejects.toThrow(/could not parse the response/);
});
