import { expect, expectTypeOf, test } from "vitest";
import { models } from "./harness-config.ts";
import { type AskJevOptions, askJev, choice, score, yesNo } from "./jev.ts";

test("decision question helpers build serializable descriptors", () => {
  const questions = {
    sameCompany: yesNo("Do these records identify the same company?"),
    disposition: choice("What should happen?", {
      match: "Link the records",
      review: "Ask a person to review",
    }),
    similarity: score("How closely do the records align?", ["Different", "Possible", "Same"]),
  };

  expect(JSON.parse(JSON.stringify(questions))).toEqual({
    sameCompany: {
      type: "yes-no",
      instructions: "Do these records identify the same company?",
    },
    disposition: {
      type: "choice",
      instructions: "What should happen?",
      options: { match: "Link the records", review: "Ask a person to review" },
    },
    similarity: {
      type: "score",
      instructions: "How closely do the records align?",
      levels: ["Different", "Possible", "Same"],
    },
  });
});

test("askJev preserves each named question's answer type", async () => {
  const result = askJev(
    {
      model: models.openrouter("typesafe/jev-1.13"),
      state: { crm: "Acme", billing: "ACME Inc." },
      questions: {
        sameCompany: yesNo("Same company?"),
        disposition: choice("What next?", { match: "Link", review: "Review" }),
        similarity: score("Similarity?", ["Different", "Possible", "Same"]),
      },
    },
    async () => {
      throw new Error("type-only durable step");
    },
  );

  type Result = Awaited<typeof result>;
  expectTypeOf<Result["answers"]["sameCompany"]>().toEqualTypeOf<{ probability: number }>();
  expectTypeOf<Result["answers"]["disposition"]["choice"]>().toEqualTypeOf<"match" | "review">();
  expectTypeOf<Result["answers"]["similarity"]["score"]>().toEqualTypeOf<number>();
  await expect(result).rejects.toThrow("type-only durable step");
});

test("decision state rejects values that JSON cannot represent", () => {
  class Account {
    format() {
      return "account";
    }
  }
  const functionState: AskJevOptions<{ match: ReturnType<typeof yesNo> }> = {
    model: models.openrouter("typesafe/jev-1.13"),
    // @ts-expect-error functions are not JSON values
    state: { calculate: () => 1 },
    questions: { match: yesNo("Match?") },
  };
  const bigintState: AskJevOptions<{ match: ReturnType<typeof yesNo> }> = {
    model: models.openrouter("typesafe/jev-1.13"),
    // @ts-expect-error bigint is not a JSON value
    state: { accountId: 1n },
    questions: { match: yesNo("Match?") },
  };
  const classState: AskJevOptions<{ match: ReturnType<typeof yesNo> }> = {
    model: models.openrouter("typesafe/jev-1.13"),
    // @ts-expect-error class instances with methods are not JSON values
    state: { account: new Account() },
    questions: { match: yesNo("Match?") },
  };
  expect([functionState, bigintState, classState]).toHaveLength(3);
});

test("decision state accepts nested JSON objects and arrays", () => {
  const request: AskJevOptions<{ match: ReturnType<typeof yesNo> }> = {
    model: models.openrouter("typesafe/jev-1.13"),
    state: { account: ["Acme", 42, true, null, { active: false }] },
    questions: { match: yesNo("Match?") },
  };
  expect(request.state).toEqual({ account: ["Acme", 42, true, null, { active: false }] });
});
