import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeTmpDir, removeTmpDir } from "../agent/harnesses/test-fixtures.ts";
import { jigsPrompts, withPrompts } from "./jigs-prompts.ts";
import { createPromptRegistry } from "./registry.ts";

let tmp: string;
beforeAll(() => {
  tmp = makeTmpDir();
  mkdirSync(path.join(tmp, "prompts"));
  writeFileSync(
    path.join(tmp, "prompts", "greet.prompt.md"),
    "hello <%= it.WHO %>\n",
  );
});
afterAll(() => removeTmpDir(tmp));

test("a file source resolves relative to the registry's root", () => {
  const prompts = createPromptRegistry(
    { greet: { file: "prompts/greet.prompt.md" } },
    { root: tmp },
  );
  expect(prompts.render("greet", { WHO: "salim" })).toBe("hello salim\n");
});

test("a variable the data does not carry throws, naming prompt and variable", () => {
  const prompts = createPromptRegistry({
    greet: { template: "hello <%= it.WHO %>" },
  });
  expect(() => prompts.render("greet", {})).toThrow(
    'prompt "greet" reads WHO, which its data does not carry',
  );
});

test("data is interpolated, never compiled — a value carrying a tag stays text", () => {
  const prompts = createPromptRegistry({
    ticket: { template: "<%= it.BODY %>" },
  });
  expect(prompts.render("ticket", { BODY: "<%= it.SECRET %>" })).toBe(
    "<%= it.SECRET %>",
  );
});

test("an included fragment sees the caller's data and its own missing reads", () => {
  const prompts = createPromptRegistry({
    "@rules": { template: "be brief, <%= it.WHO %>" },
    greet: { template: "hi <%= it.WHO %> — <%~ include('@rules') %>" },
  });
  expect(prompts.render("greet", { WHO: "salim" })).toBe(
    "hi salim — be brief, salim",
  );
  // Strictness survives the include: the fragment's read is checked too.
  const strict = createPromptRegistry({
    "@rules": { template: "<%= it.MISSING %>" },
    greet: { template: "<%~ include('@rules') %>" },
  });
  expect(() => strict.render("greet", {})).toThrow(
    'prompt "greet" reads MISSING',
  );
});

test("a function source skips the template engine entirely", () => {
  const prompts = createPromptRegistry({
    greet: (data) => `hello ${String(data.WHO)}`,
  });
  expect(prompts.render("greet", { WHO: "salim" })).toBe("hello salim");
  expect(prompts.check()).toEqual([]);
});

test("an unregistered name fails loudly, listing what is registered", () => {
  const prompts = createPromptRegistry({ greet: { template: "hi" } });
  expect(() => prompts.render("nope", {})).toThrow(
    'no prompt named "nope" is registered — registered: greet',
  );
});

test("check reports a parse error and leaves every other prompt renderable", () => {
  const prompts = createPromptRegistry({
    broken: { template: "<%= it.OOPS" },
    fine: { template: "<%= it.OK %>" },
  });
  const failures = prompts.check();
  expect(failures).toHaveLength(1);
  expect(failures[0]?.name).toBe("broken");
  expect(failures[0]?.error).toContain("unclosed tag");
  expect(prompts.render("fine", { OK: "yes" })).toBe("yes");
  expect(() => prompts.render("broken", {})).toThrow("could not be loaded");
});

test("check renders with every variable resolved, so a full prompt needs no data", () => {
  const prompts = createPromptRegistry({
    greet: { template: "hello <%= it.WHO %>" },
  });
  expect(prompts.check()).toEqual([]);
});

test("every prompt jigs ships parses and renders", () => {
  expect(jigsPrompts.check()).toEqual([]);
  expect(jigsPrompts.names()).toEqual([
    "@plain-language",
    "answer-review",
    "code-review",
    "commit-work",
    "fix-ci",
    "fix-ci-fresh",
    "implement",
    "needs-human-comment",
    "proceeding-note",
    "read-reply",
    "rebuild-context",
    "ticket-review",
  ]);
});

test("a factory's sources are layered over jigs', replacing by name", () => {
  const prompts = withPrompts(
    {
      implement: { template: "this factory's own implement prompt" },
      "describe-pr": { file: "prompts/greet.prompt.md" },
    },
    { root: tmp },
  );
  expect(prompts.render("implement", {})).toBe(
    "this factory's own implement prompt",
  );
  expect(prompts.render("describe-pr", { WHO: "salim" })).toBe("hello salim\n");
  // Everything jigs ships is still there, unshadowed.
  expect(prompts.render("commit-work", {})).toContain("# Commit your work");
  expect(prompts.check()).toEqual([]);
});
