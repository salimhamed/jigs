import { expect, expectTypeOf, test } from "vitest";
import { askJev, choice, models, score, yesNo } from "../../../blocks/agents/index.ts";
import { executeJev } from "../execute-model-request.ts";

const configured = Boolean(process.env.OPENROUTER_API_KEY);

const state = {
  crm: { name: "Acme Labs", domain: "acme.example" },
  billing: { name: "Acme Labs LLC", domain: "acme.example" },
};

test.skipIf(!configured)("jev returns all three calibrated answer types", async () => {
  const result = await askJev(
    {
      model: models.openrouter("typesafe/jev-1.13"),
      state,
      questions: {
        sameCompany: yesNo("Do these records identify the same company?"),
        disposition: choice("What should happen next?", {
          match: "Link the records automatically",
          review: "Send the records to a person",
        }),
        similarity: score("How closely do the records align?", [
          "Different companies",
          "Possibly the same company",
          "The same company",
        ]),
      },
    },
    (wire) => executeJev(wire, { workflowRunId: `live-jev-${crypto.randomUUID()}` }),
  );

  expect(result.answers.sameCompany.probability).toBeGreaterThanOrEqual(0);
  expect(result.answers.sameCompany.probability).toBeLessThanOrEqual(1);
  expect(["match", "review"]).toContain(result.answers.disposition.choice);
  expect(Object.values(result.answers.disposition.probabilities)).toSatisfy((values: number[]) =>
    values.every((probability) => probability >= 0 && probability <= 1),
  );
  expectTypeOf(result.answers.similarity.score).toEqualTypeOf<number>();
  expect(result.answers.similarity.score).toBeGreaterThanOrEqual(0);
  expect(result.answers.similarity.score).toBeLessThanOrEqual(2);
  expect(Object.values(result.answers.similarity.probabilities)).toSatisfy((values: number[]) =>
    values.every((probability) => probability >= 0 && probability <= 1),
  );
  expect(result.answers.similarity.legend).toEqual({
    "0": "Different companies",
    "1": "Possibly the same company",
    "2": "The same company",
  });
});
