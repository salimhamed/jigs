import { vi } from "vitest";
import type { ExecuteJevStep, JevQuestion } from "./jev.ts";

type Request = { site?: string; state: unknown; questions: Record<string, JevQuestion> };

/** A Jev step that answers every question from `respond`, given the site, state and question key. */
export function jevAnswering(
  respond: (site: string | undefined, state: unknown, key: string) => unknown,
) {
  const step = vi.fn(async (request: Request) => ({
    answers: Object.fromEntries(
      Object.keys(request.questions).map((key) => [key, respond(request.site, request.state, key)]),
    ),
  }));
  // A mock cannot keep the step's generic signature.
  return step as unknown as ExecuteJevStep & typeof step;
}

/** A Jev step too unsure of everything: every decision resolves to its `whenUnsure`. */
export function unsureJev() {
  const step = vi.fn(async (request: Request) => ({
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([key, question]) => [key, unsure(question)]),
    ),
  }));
  return step as unknown as ExecuteJevStep & typeof step;
}

function unsure(question: JevQuestion): unknown {
  if (question.type === "yes-no") return { probability: 0.5 };
  if (question.type === "choice") {
    const options = Object.keys(question.options);
    return {
      choice: options[0],
      probabilities: Object.fromEntries(options.map((option) => [option, 1 / options.length])),
      confidence: 1 / options.length,
    };
  }
  return { score: 0, probabilities: {}, legend: {}, confidence: 0.5 };
}

/** A confident choice answer. */
export function confidentChoice(choice: string) {
  return { choice, probabilities: { [choice]: 0.97 }, confidence: 0.97 };
}

/** A yes-or-no answer given with the probability of yes. */
export function yesProbability(probability: number) {
  return { probability };
}
