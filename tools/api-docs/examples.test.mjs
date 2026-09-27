import { expect, test } from "vitest";
import { checkDocumentationExamples, checkExamples, examplesIn } from "./examples.mjs";

test("the displayed TypeScript examples compile without hidden imports or variables", async () => {
  expect(await checkDocumentationExamples()).toBeGreaterThan(0);
}, 60_000);

test("examples stay isolated and report missing variables at their documentation lines", async () => {
  const examples = examplesIn(
    "# Example\n\n```ts\nconst claim = 1;\n```\n\n```ts\nconsole.log(claim);\n```\n",
    "guide.md",
  );
  expect(await checkExamples(examples)).toEqual(["guide.md:8:13: Cannot find name 'claim'."]);
}, 30_000);

test("configuration fragments validate properties without filling in identifiers", async () => {
  const examples = examplesIn(
    "```ts factory-options\nservice: { dashboardPort: missingPort },\n```\n\n```ts factory-options\nunknownSetting: true,\n```\n",
    "configuration.md",
  );
  const errors = await checkExamples(examples);
  expect(errors).toHaveLength(2);
  expect(errors[0]).toContain("configuration.md:2:27: Cannot find name 'missingPort'.");
  expect(errors[1]).toContain("'unknownSetting' does not exist");
}, 30_000);
