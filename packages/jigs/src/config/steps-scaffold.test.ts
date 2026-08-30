import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  appendBlock,
  missingWrappers,
  STEPS_FILE,
  templateWrappers,
} from "./steps-scaffold.ts";
import { locateTemplates, TEMPLATE_SUFFIX } from "./templates.ts";

const template = readFileSync(
  path.join(locateTemplates(), `${STEPS_FILE}${TEMPLATE_SUFFIX}`),
  "utf8",
);

test("the scaffold template is the one list of jigs' steps", () => {
  const names = templateWrappers(template).map((wrapper) => wrapper.name);

  // Every id in e2e/fixture-factory/expected-ids.txt comes from this list, so
  // a step added to jigs without a wrapper here reaches no factory at all.
  expect(names).toContain("worktree");
  expect(names).toContain("runAgentStep");
  expect(names).toContain("squashMerge");
  expect(new Set(names).size).toBe(names.length);
  for (const wrapper of templateWrappers(template)) {
    expect(wrapper.source, wrapper.name).toContain('"use step"');
  }
});

test("the wrappers the fixture factory compiles are the ones the template declares", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const recorded = readFileSync(
    path.join(
      here,
      "..",
      "..",
      "..",
      "..",
      "e2e",
      "fixture-factory",
      "expected-ids.txt",
    ),
    "utf8",
  );

  for (const wrapper of templateWrappers(template)) {
    expect(recorded, wrapper.name).toContain(
      `step//./steps/jigs//${wrapper.name}`,
    );
  }
});

test("a factory that has every wrapper is offered nothing", () => {
  expect(missingWrappers(template, template)).toEqual([]);
});

test("a renamed wrapper counts as missing — the name is half the step id", () => {
  const renamed = template.replace(
    "export async function readDiff(",
    "export async function readTheDiff(",
  );

  expect(missingWrappers(template, renamed).map((w) => w.name)).toEqual([
    "readDiff",
  ]);
});

test("the appended block carries only the imports the factory does not already have", () => {
  // What a factory scaffolded before the step existed looks like: neither the
  // wrapper nor the import it needs, but plenty of others still bound.
  const before = template
    .replace(/export async function worktree\([\s\S]*?\n}\n/, "")
    .replace("  provisionRunWorktree,\n", "");
  const missing = missingWrappers(template, before);

  const block = appendBlock(missing, before);

  expect(block).toContain("export async function worktree(");
  expect(block).toContain(
    'import { provisionRunWorktree } from "@jigs/service/worktrees";',
  );
  // Still bound by what stayed behind, so re-importing them would not compile.
  expect(block).not.toContain("getWorkflowMetadata }");
  expect(block).not.toContain("WorktreeFacts }");
});

test("an appended type import stays a type import", () => {
  const block = appendBlock(
    templateWrappers(template).filter((w) => w.name === "worktree"),
    "",
  );

  expect(block).toContain(
    'import type { WorktreeRequest } from "@jigs/service/worktrees";',
  );
});
