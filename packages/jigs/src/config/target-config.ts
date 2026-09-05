import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { CliError } from "../errors.ts";

export const TARGET_CONFIG_FILE = ".jigs.yml";

const worktreeSchema = z.strictObject({
  copy: z.array(z.string()).default([]),
  post_create: z.array(z.string()).default([]),
  hook_timeout_minutes: z.number().positive().default(10),
});

// Loose at the root: the target repo's file is the target team's, and jigs
// only owns the `worktree:` section.
const targetConfigSchema = z.looseObject({
  worktree: worktreeSchema.prefault({}),
});

export type TargetWorktreeConfig = z.output<typeof worktreeSchema>;
export type TargetConfig = z.output<typeof targetConfigSchema>;

export function parseTargetConfig(text: string): TargetConfig {
  const doc = parseDocument(text);
  const firstError = doc.errors[0];
  if (firstError !== undefined) {
    throw new CliError(`invalid ${TARGET_CONFIG_FILE}: ${firstError.message}`);
  }
  const result = targetConfigSchema.safeParse(doc.toJS() ?? {});
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new CliError(
      `invalid ${TARGET_CONFIG_FILE}:\n  ${lines.join("\n  ")}`,
    );
  }
  return result.data;
}

// A directory with no .jigs.yml reads as schema defaults — copying nothing and
// running nothing is a valid answer, not a misconfiguration.
export function readTargetConfig(dir: string): TargetConfig {
  const file = path.join(dir, TARGET_CONFIG_FILE);
  if (!existsSync(file)) return targetConfigSchema.parse({});
  return parseTargetConfig(readFileSync(file, "utf8"));
}

// Copying nothing and running nothing is a valid answer, so a caller wanting
// the defaults asks for them by name rather than reading them off a miss.
// Frozen because one object is shared by every caller that asks.
export const DEFAULT_WORKTREE_CONFIG: TargetWorktreeConfig = freezeConfig(
  worktreeSchema.parse({}),
);

function freezeConfig(config: TargetWorktreeConfig): TargetWorktreeConfig {
  Object.freeze(config.copy);
  Object.freeze(config.post_create);
  return Object.freeze(config);
}

// Seed first, worktree second: the seed directory is the operator's deliberate
// answer for a target repo whose .jigs.yml is untracked, the worktree carries
// the repo's own committed one. null so a run that found neither says so in
// the log rather than provisioning silently.
export function resolveWorktreeConfig(options: {
  seedDir: string;
  worktreePath: string;
}): TargetWorktreeConfig | null {
  for (const dir of [options.seedDir, options.worktreePath]) {
    if (existsSync(path.join(dir, TARGET_CONFIG_FILE))) {
      return readTargetConfig(dir).worktree;
    }
  }
  return null;
}
