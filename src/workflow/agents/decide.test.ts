import { expect, expectTypeOf, test, vi } from "vitest";
import { DECISION_CUTOFF, type Decided, decide, jevModel, resolveAnswer } from "./decide.ts";
import { choice, type ExecuteJevStep, score, yesNo } from "./jev.ts";

const wake = choice("What next?", { idle: "Wait", builder: "Act" });

function answering(answers: Record<string, unknown>) {
  const step = vi.fn(async (_request: unknown) => ({ answers }));
  // A mock cannot keep the step's generic signature.
  return step as unknown as ExecuteJevStep & typeof step;
}

const sure = { choice: "idle", probabilities: { idle: 0.93, builder: 0.07 }, confidence: 0.93 };

test("a confident choice is acted on, and an unsure one resolves to whenUnsure", async () => {
  const executeJev = answering({ wake: sure });

  const confident = await decide(
    {
      site: "wake",
      state: "CI running",
      questions: { wake: { question: wake, whenUnsure: "builder" } },
    },
    executeJev,
  );
  const unsure = await decide(
    {
      site: "wake",
      state: "CI running",
      questions: { wake: { question: wake, whenUnsure: "builder", cutoff: 0.95 } },
    },
    executeJev,
  );

  expect(confident).toEqual({ wake: "idle" });
  expect(unsure).toEqual({ wake: "builder" });
  expect(executeJev).toHaveBeenCalledWith({
    model: jevModel,
    site: "wake",
    state: "CI running",
    questions: { wake },
    rules: { wake: { whenUnsure: "builder", cutoff: DECISION_CUTOFF } },
  });
});

test("several questions are asked in one call and each resolves on its own rule", async () => {
  const reply = yesNo("Is this a reply?");
  const executeJev = answering({ wake: sure, reply: { probability: 0.6 } });

  const decided = await decide(
    {
      site: "both",
      state: "",
      questions: {
        wake: { question: wake, whenUnsure: "builder" },
        reply: { question: reply, whenUnsure: false },
      },
    },
    executeJev,
  );

  expect(decided).toEqual({ wake: "idle", reply: false });
  expect(executeJev).toHaveBeenCalledTimes(1);
});

test("a yes-or-no answer is as confident as its more likely side", () => {
  expect(resolveAnswer({ whenUnsure: true }, { probability: 0.04 })).toEqual({
    value: false,
    confidence: 0.96,
    unsure: false,
  });
  expect(resolveAnswer({ whenUnsure: true }, { probability: 0.3 })).toEqual({
    value: true,
    confidence: 0.7,
    unsure: true,
  });
});

test("a score resolves to its nearest level", () => {
  const answer = { score: 1.8, probabilities: {}, legend: {}, confidence: 0.95 };
  expect(resolveAnswer({ whenUnsure: 0 }, answer)).toEqual({
    value: 2,
    confidence: 0.95,
    unsure: false,
  });
});

test("a cutoff outside 0 to 1 is refused before any model call", async () => {
  const executeJev = answering({});

  await expect(
    decide(
      {
        site: "reply",
        state: "",
        questions: { reply: { question: yesNo("Reply?"), whenUnsure: true, cutoff: 90 } },
      },
      executeJev,
    ),
  ).rejects.toThrow('decision "reply.reply" needs a cutoff between 0 and 1');
  expect(executeJev).not.toHaveBeenCalled();
});

test("each value's type follows its question", () => {
  const level = score("How big?", ["small", "large"]);
  type Rules = {
    wake: { question: typeof wake; whenUnsure: "builder" };
    reply: { question: ReturnType<typeof yesNo>; whenUnsure: false };
    size: { question: typeof level; whenUnsure: 1 };
  };
  expectTypeOf<Decided<Rules>>().toEqualTypeOf<{
    wake: "idle" | "builder";
    reply: boolean;
    size: number;
  }>();
});
