import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { checkFactoryIntegration, generateFactoryIntegration } from "./integration.ts";

const roots: string[] = [];
function factory() {
  const root = mkdtempSync(path.join(tmpdir(), "jigs-integration-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("generation is repeatable and build validation never overwrites drift", () => {
  const root = factory();
  expect(() => checkFactoryIntegration(root)).toThrow(/missing or differs/);
  const file = generateFactoryIntegration(root);
  const generated = readFileSync(file, "utf8");
  checkFactoryIntegration(root);
  generateFactoryIntegration(root);
  expect(readFileSync(file, "utf8")).toBe(generated);

  const customized = `${generated}\n// custom code belongs elsewhere\n`;
  writeFileSync(file, customized);
  expect(() => checkFactoryIntegration(root)).toThrow(/missing or differs/);
  expect(readFileSync(file, "utf8")).toBe(customized);

  generateFactoryIntegration(root);
  checkFactoryIntegration(root);
  expect(readFileSync(file, "utf8")).toBe(generated);
});

// The one write jigs must never repeat blind. The SDK reads `maxRetries` off
// the step function, so the property has to survive into the factory's own
// file — a generated wrapper without it retries a POST that may already have
// posted.
test("the pull request POST wrappers are generated single-attempt", () => {
  const generated = readFileSync(generateFactoryIntegration(factory()), "utf8");
  expect(generated).toContain("replyToPullRequestReviewThread.maxRetries = 0;");
  expect(generated).toContain("commentOnPullRequest.maxRetries = 0;");
});
