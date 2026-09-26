import { expect, expectTypeOf, test, vi } from "vitest";
import { type Decision, decide, jevModel } from "./decide.ts";
import { choice, type ExecuteJevStep, yesNo } from "./jev.ts";

const wake = choice("What next?", { idle: "Wait", builder: "Act" });

function answering(answer: unknown) {
  const step = vi.fn(async (_request: unknown) => ({ answers: { decision: answer } }));
  // A mock cannot keep the step's generic signature.
  return step as unknown as ExecuteJevStep & typeof step;
}

test("a choice clears its cutoff on the model's confidence", async () => {
  const executeJev = answering({
    choice: "idle",
    probabilities: { idle: 0.93, builder: 0.07 },
    confidence: 0.93,
  });

  const confident = await decide(
    { site: "wake", state: "CI running", question: wake, cutoff: 0.9 },
    executeJev,
  );
  const unsure = await decide(
    { site: "wake", state: "CI running", question: wake, cutoff: 0.95 },
    executeJev,
  );

  expect(confident).toMatchObject({
    confident: true,
    confidence: 0.93,
    answer: { choice: "idle" },
  });
  expect(unsure.confident).toBe(false);
  expect(executeJev).toHaveBeenCalledWith({
    model: jevModel,
    site: "wake",
    state: "CI running",
    questions: { decision: wake },
  });
});

test("a yes-or-no answer is as confident as its more likely side", async () => {
  const question = yesNo("Is this a reply?");

  const no = await decide(
    { site: "reply", state: "+1", question, cutoff: 0.9 },
    answering({ probability: 0.04 }),
  );
  const leaning = await decide(
    { site: "reply", state: "maybe", question, cutoff: 0.9 },
    answering({ probability: 0.6 }),
  );

  expect(no).toMatchObject({ yes: false, confident: true, confidence: 0.96 });
  expect(leaning).toMatchObject({ yes: true, confident: false, confidence: 0.6 });
});

test("a cutoff outside 0 to 1 is refused before any model call", async () => {
  const executeJev = answering({ probability: 1 });

  await expect(
    decide({ site: "reply", state: "", question: yesNo("Reply?"), cutoff: 90 }, executeJev),
  ).rejects.toThrow('decision "reply" needs a cutoff between 0 and 1');
  expect(executeJev).not.toHaveBeenCalled();
});

test("the decision type follows the question", () => {
  expectTypeOf<Decision<typeof wake>["answer"]["choice"]>().toEqualTypeOf<"idle" | "builder">();
  expectTypeOf<Decision<ReturnType<typeof yesNo>>["yes"]>().toEqualTypeOf<boolean>();
  expectTypeOf<Decision<typeof wake>>().not.toHaveProperty("yes");
});
