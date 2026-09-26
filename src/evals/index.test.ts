import { expect, test, vi } from "vitest";
import { choice, type ExecuteJevStep } from "../workflow/agents/jev.ts";
import { runEvalSet } from "./index.ts";

const wake = choice("What next?", { idle: "Wait", builder: "Act" });

function answering(byState: Record<string, unknown>) {
  const step = vi.fn(async (wire: { state: unknown }) => ({
    answers: { decision: byState[String(wire.state)] },
  }));
  // A mock cannot keep the step's generic signature.
  return step as unknown as ExecuteJevStep;
}

const choose = (choice: string, confidence: number) => ({ choice, probabilities: {}, confidence });

test("a set reports accuracy, what was acted on, and sure-but-wrong answers", async () => {
  let text = "";
  const outcomes = await runEvalSet(
    {
      site: "wake",
      rule: { question: wake, whenUnsure: "builder" },
      cases: [
        { name: "quiet", state: "quiet", expected: "idle" },
        { name: "red", state: "red", expected: "builder" },
        { name: "odd", state: "odd", expected: "builder" },
      ],
    },
    {
      executeJev: answering({
        quiet: choose("idle", 0.97),
        red: choose("idle", 0.95),
        odd: choose("idle", 0.5),
      }),
      write: (chunk) => {
        text += chunk;
      },
    },
  );

  expect(outcomes.map((outcome) => [outcome.answer, outcome.unsure])).toEqual([
    ["idle", false],
    ["idle", false],
    ["idle", true],
  ]);
  expect(text).toContain("- Accuracy: 1/3");
  expect(text).toContain("- Acted on (cutoff 0.9): 2/3");
  expect(text).toContain("- Sure but wrong: 1");
  expect(text).toContain("- MISS odd: expected builder, got idle (0.50, unsure)");
});

test("a set whose every case errors throws, because the setup is broken", async () => {
  const failing = vi.fn(async () => {
    throw new Error("no key");
  }) as unknown as ExecuteJevStep;
  await expect(
    runEvalSet(
      {
        site: "wake",
        rule: { question: wake, whenUnsure: "builder" },
        cases: [{ name: "quiet", state: "quiet", expected: "idle" }],
      },
      { executeJev: failing, write: () => {} },
    ),
  ).rejects.toThrow("every wake case errored; first: no key");
});
