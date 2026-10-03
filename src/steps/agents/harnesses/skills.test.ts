import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { copySkills, prepareClaudeSkillsPlugin, skillFolder } from "./skills.ts";
import { makeTmpDir, removeTmpDir } from "./test-fixtures.ts";

let tmp: string;
let factory: string;

function skill(relative: string): string {
  const folder = path.join(factory, relative);
  mkdirSync(path.join(folder, "reference"), { recursive: true });
  writeFileSync(path.join(folder, "SKILL.md"), `# ${relative}\n`);
  writeFileSync(path.join(folder, "reference", "notes.md"), "notes\n");
  return folder;
}

beforeEach(() => {
  tmp = makeTmpDir();
  factory = path.join(tmp, "factory");
});
afterEach(() => {
  removeTmpDir(tmp);
});

test("a relative skill path starts at the factory root and an absolute one stands", () => {
  expect(skillFolder("skills/a", () => factory)).toBe(path.join(factory, "skills", "a"));
  expect(skillFolder("/opt/skills/a", () => factory)).toBe("/opt/skills/a");
  expect(skillFolder("/opt/skills/a/..", () => factory)).toBe("/opt/skills");
  expect(skillFolder("/opt/skills/a/.", () => factory)).toBe("/opt/skills/a");
});

test("skills are copied by folder name, links followed, so the source is never reachable", () => {
  skill("skills/snowflake");
  writeFileSync(path.join(tmp, "shared.md"), "shared\n");
  symlinkSync(path.join(tmp, "shared.md"), path.join(factory, "skills/snowflake/shared.md"));
  const destination = path.join(tmp, "out");

  const copied = copySkills(["skills/snowflake"], destination, () => factory);

  expect(copied).toEqual([path.join(destination, "snowflake")]);
  expect(readFileSync(path.join(destination, "snowflake/reference/notes.md"), "utf8")).toBe(
    "notes\n",
  );
  writeFileSync(path.join(destination, "snowflake/shared.md"), "changed\n");
  expect(readFileSync(path.join(tmp, "shared.md"), "utf8")).toBe("shared\n");
});

test("two skill folders with one name are refused", () => {
  skill("a/pdf");
  skill("b/pdf");
  expect(() => copySkills(["a/pdf", "b/pdf"], path.join(tmp, "out"), () => factory)).toThrow(
    "are both named pdf",
  );
});

test("the Claude plugin holds a manifest and the skills, and cleanup removes it", () => {
  skill("skills/snowflake");
  const plugin = prepareClaudeSkillsPlugin("wrun_1", ["skills/snowflake"], {
    baseDir: path.join(tmp, "plugins"),
    root: () => factory,
  });

  expect(path.dirname(plugin.path)).toBe(path.join(tmp, "plugins"));
  expect(
    JSON.parse(readFileSync(path.join(plugin.path, ".claude-plugin/plugin.json"), "utf8")),
  ).toEqual({ name: "jigs-skills", description: "Skills declared by the workflow" });
  expect(existsSync(path.join(plugin.path, "skills/snowflake/SKILL.md"))).toBe(true);
  plugin.cleanup();
  expect(existsSync(plugin.path)).toBe(false);
});

test("a plugin that cannot be built leaves nothing behind", () => {
  const base = path.join(tmp, "plugins");
  expect(() =>
    prepareClaudeSkillsPlugin("wrun_1", ["skills/missing"], { baseDir: base, root: () => factory }),
  ).toThrow();
  expect(readdirSync(base)).toEqual([]);
});

test("a path naming no folder of its own is refused rather than copied into the destination", () => {
  expect(() => copySkills(["/"], path.join(tmp, "out"), () => factory)).toThrow(
    "names no skill folder",
  );
});
