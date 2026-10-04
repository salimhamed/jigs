import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { currentFactoryContext } from "../config/factory-context.ts";
import { JigsError } from "../errors.ts";
import { skillFolder, skillName } from "../steps/agents/shared/skills.ts";
import type { Check, CheckResult } from "./check.ts";

const DESCRIPTOR = "the agent's harness descriptor";

function inspect(skills: readonly string[], index: number, root: () => string): CheckResult {
  const entry = skills[index] as string;
  let folder: string;
  let earlier: string[];
  try {
    folder = skillFolder(entry, root);
    earlier = skills.slice(0, index).map((other) => skillFolder(other, root));
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      repair:
        err instanceof JigsError && err.hint !== undefined
          ? err.hint
          : `fix the skill path in ${DESCRIPTOR}`,
    };
  }
  const name = skillName(folder);
  if (name === undefined) {
    return {
      ok: false,
      reason: `${entry} names no skill folder`,
      repair: `name the skill's own folder in ${DESCRIPTOR}`,
    };
  }
  const clash = earlier.find((other) => skillName(other) === name);
  if (clash !== undefined) {
    return {
      ok: false,
      reason: `${folder} and ${clash} would both load as the skill ${name}`,
      repair: `rename one of the folders, or drop one from ${DESCRIPTOR}`,
    };
  }
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    return {
      ok: false,
      reason: `no skill folder at ${folder}`,
      repair: `create ${folder} holding a SKILL.md, or fix the path in ${DESCRIPTOR}; a relative path starts at the factory root`,
    };
  }
  const manifest = path.join(folder, "SKILL.md");
  if (!existsSync(manifest)) {
    return {
      ok: false,
      reason: `${folder} has no SKILL.md`,
      repair: `add the skill's instructions at ${manifest}`,
    };
  }
  return { ok: true, detail: folder };
}

/**
 * One check per declared skill path: the folder exists, holds a `SKILL.md`, and has a name no
 * earlier path in the list already uses.
 */
export function skillChecks(
  skills: readonly string[],
  root: () => string = () => currentFactoryContext().root,
): Check[] {
  return skills.map((entry, index) => ({
    id: `skills.${entry}`,
    label: `skill ${entry}`,
    run: async () => inspect(skills, index, root),
  }));
}
