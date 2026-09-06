// The loop: the thread as messages in, one Slack-shaped line of text out, and
// the factory's own tools in between. A plain generateText tool loop rather
// than a coding-agent harness — this agent reads and starts runs, it does not
// edit anything, and a harness would put a sandbox and a session store
// between the operator's question and the answer.

import {
  generateText,
  type LanguageModel,
  type ModelMessage,
  stepCountIs,
  type Tool,
} from "ai";

// Eight is a question answered, not a task worked: list the pipelines, read
// their inputs, start a run, read it back. A thread that needs more than that
// is one the operator should be having with the dashboard.
const MAX_STEPS = 8;

// A provider that accepts the request and never answers would otherwise hold
// this thread's queue open forever, and every later message in it with the
// queue. Two minutes is long for eight steps and short enough that the
// operator gets an error rather than silence.
const TOTAL_TIMEOUT_MS = 120_000;

const NOTHING_TO_ANSWER =
  "There is nothing for me to read in this thread yet — say something and I will pick it up.";

/** The run a thread belongs to. Every run has a thread of its own, so most
 *  threads have one — and in those, "what is this waiting on?" is a question
 *  about a run nobody has to name. */
export interface ThreadRunContext {
  runId: string;
  pipeline: string;
  status: string;
}

export interface SlackAgentDeps {
  model: LanguageModel;
  tools: Record<string, Tool>;
  pipelines: readonly string[];
  run?: ThreadRunContext | null;
  maxSteps?: number;
  timeoutMs?: number;
}

export function slackSystemPrompt(
  pipelines: readonly string[],
  run?: ThreadRunContext | null,
): string {
  return [
    "You are the jigs operator's assistant for one software factory, answering in Slack.",
    "jigs runs pipelines: each run takes a ticket through agent implementation, review and human approval to a merged PR. A run can be running, suspended (parked waiting on something external), stalled (nothing is coming to move it), completed, failed or cancelled.",
    pipelines.length === 0
      ? "This factory declares no pipelines."
      : `This factory's pipelines: ${pipelines.join(", ")}.`,
    ...(run === undefined || run === null
      ? []
      : [
          `This thread belongs to run ${run.runId} (pipeline ${run.pipeline}, status ${run.status}). When the operator says "it", "this run" or "the run" without naming one, that is the run they mean. The status here is from when the thread was read, so read the run with the tools before reporting on it.`,
        ]),
    "Answer with the tools, never from memory or guesswork. Never invent a run id, a pipeline name or a status — if a tool did not tell you, say you do not know.",
    "When a pipeline needs an input the operator did not give, ask for it. Do not guess one.",
    "Cancel a run only when the operator has explicitly asked you to cancel it.",
    "Reply in brief Slack plain text: no markdown headings, no tables, no bullet walls. A sentence or two, and the run ids or names that matter.",
  ].join("\n\n");
}

/**
 * One turn. Rejects only if the model call itself fails — tool failures come
 * back as tool results and the model answers around them.
 */
export async function answerThread(
  messages: ModelMessage[],
  deps: SlackAgentDeps,
): Promise<string> {
  // A thread of nothing but dropped turns — an unlisted author, a bare file
  // share — is not a question, and the SDK rejects an empty prompt anyway.
  if (messages.length === 0) return NOTHING_TO_ANSWER;
  const result = await generateText({
    model: deps.model,
    system: slackSystemPrompt(deps.pipelines, deps.run),
    messages,
    tools: deps.tools,
    stopWhen: stepCountIs(deps.maxSteps ?? MAX_STEPS),
    timeout: { totalMs: deps.timeoutMs ?? TOTAL_TIMEOUT_MS },
  });
  const text = result.text.trim();
  // A model that spent its last step on a tool call leaves no text at all,
  // and silence in a thread reads as the service being down.
  return text === ""
    ? "I ran out of steps before I had an answer. Ask me again, more narrowly?"
    : text;
}
