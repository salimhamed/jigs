import { vi } from "vitest";
import type { ExecuteJevStep, JevQuestion } from "./jev.ts";

type Request = { site?: string; state: unknown; questions: Record<string, JevQuestion> };

/** A Jev step that answers every `decide` call from `respond`, keyed by site. */
export function jevAnswering(respond: (site: string | undefined, state: unknown) => unknown) {
  const step = vi.fn(async (request: Request) => ({
    answers: { decision: respond(request.site, request.state) },
  }));
  // A mock cannot keep the step's generic signature.
  return step as unknown as ExecuteJevStep & typeof step;
}

/** A Jev step too unsure to change anything: every site falls back to its behaviour without Jev. */
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
