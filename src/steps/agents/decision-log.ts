import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AskJevOptions, JevAnswers, JevQuestions } from "../../workflow/agents/jev.ts";
import type { RunMetadata } from "../runtime/run-context.ts";
import { runDirectory } from "../runtime/run-directory/index.ts";

/** The run's decision log: one JSON line per answered `askJev` call. */
export function decisionLogPath(metadata: RunMetadata): string {
  return path.join(runDirectory(metadata), "decisions.jsonl");
}

// The log feeds evals and reports; losing a line must never fail the decision.
export async function recordDecision<const QUESTIONS extends JevQuestions>(
  metadata: RunMetadata,
  request: AskJevOptions<QUESTIONS>,
  answers: JevAnswers<QUESTIONS>,
): Promise<void> {
  try {
    const file = decisionLogPath(metadata);
    await mkdir(path.dirname(file), { recursive: true });
    const entry = {
      at: new Date().toISOString(),
      site: request.site,
      state: request.state,
      questions: request.questions,
      answers,
    };
    await appendFile(file, `${JSON.stringify(entry)}\n`);
  } catch {}
}
