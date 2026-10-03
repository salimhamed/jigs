import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { runChecks } from "./catalog.ts";
import { skillChecks } from "./skills.ts";

let factory: string;

function skill(relative: string, manifest = true): void {
  const folder = path.join(factory, relative);
  mkdirSync(folder, { recursive: true });
  if (manifest) writeFileSync(path.join(folder, "SKILL.md"), "# skill\n");
}

async function outcomes(skills: string[]) {
  return (await runChecks(skillChecks(skills, () => factory))).checks;
}

beforeEach(() => {
  factory = makeTmpDir();
});
afterEach(() => {
  removeTmpDir(factory);
});

test("a skill folder holding a SKILL.md passes with the folder it resolved to", async () => {
  skill("skills/snowflake");
  expect(await outcomes(["skills/snowflake"])).toEqual([
    {
      id: "skills.skills/snowflake",
      label: "skill skills/snowflake",
      ok: true,
      detail: path.join(factory, "skills/snowflake"),
    },
  ]);
});

test("a missing folder fails with where it was looked for", async () => {
  const [outcome] = await outcomes(["skills/missing"]);
  expect(outcome).toMatchObject({
    ok: false,
    reason: `no skill folder at ${path.join(factory, "skills/missing")}`,
    repair: expect.stringContaining("relative path starts at the factory root"),
  });
});

test("a folder without SKILL.md fails with the file to add", async () => {
  skill("skills/empty", false);
  const [outcome] = await outcomes(["skills/empty"]);
  expect(outcome).toMatchObject({
    ok: false,
    reason: `${path.join(factory, "skills/empty")} has no SKILL.md`,
    repair: expect.stringContaining(path.join(factory, "skills/empty/SKILL.md")),
  });
});

test("a second folder with an earlier folder's name fails, the first still passes", async () => {
  skill("a/pdf");
  skill("b/pdf");
  const [first, second] = await outcomes(["a/pdf", "b/pdf"]);
  expect(first).toMatchObject({ ok: true });
  expect(second).toMatchObject({
    ok: false,
    reason: expect.stringContaining("would both load as the skill pdf"),
  });
});
