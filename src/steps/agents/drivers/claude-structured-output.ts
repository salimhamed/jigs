import type { LanguageModelMiddleware } from "ai";

type StreamResult = Awaited<ReturnType<NonNullable<LanguageModelMiddleware["wrapStream"]>>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;
type TextStart = Extract<StreamPart, { type: "text-start" }>;

// Claude Code takes a structured answer through its StructuredOutput tool, and
// ai-sdk-provider-claude-code streams every submission as text, including the
// ones Claude Code rejected against the schema. The last submission is the
// accepted one; joined with the rejected ones it is not JSON. This can go once
// the adapter streams only the accepted submission.
export const acceptedStructuredAnswer: LanguageModelMiddleware = {
  specificationVersion: "v4",
  wrapStream: async ({ doStream, params }) => {
    const result = await doStream();
    if (params.responseFormat?.type !== "json") return result;
    return { ...result, stream: result.stream.pipeThrough(lastTextOnly()) };
  },
};

function lastTextOnly(): TransformStream<StreamPart, StreamPart> {
  const texts: { start: TextStart; text: string }[] = [];
  const emitLast = (controller: TransformStreamDefaultController<StreamPart>) => {
    const last = texts.findLast(({ text }) => text !== "");
    texts.length = 0;
    if (last === undefined) return;
    const { id } = last.start;
    controller.enqueue(last.start);
    controller.enqueue({ type: "text-delta", id, delta: last.text });
    controller.enqueue({ type: "text-end", id });
  };
  return new TransformStream({
    transform(part, controller) {
      switch (part.type) {
        case "text-start":
          texts.push({ start: part, text: "" });
          return;
        case "text-delta": {
          let entry = texts.findLast(({ start }) => start.id === part.id);
          if (entry === undefined) {
            entry = { start: { type: "text-start", id: part.id }, text: "" };
            texts.push(entry);
          }
          entry.text += part.delta;
          return;
        }
        case "text-end":
          return;
        case "finish":
          emitLast(controller);
          controller.enqueue(part);
          return;
        default:
          controller.enqueue(part);
      }
    },
    flush: emitLast,
  });
}
