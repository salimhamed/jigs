import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { Document } from "yaml";

export const TARGET_CONFIG_FILE = ".jigs.yml";

const toolSetups: ReadonlyArray<readonly [string, string]> = [
  [".mise.toml", "mise install"],
  [".tool-versions", "mise install"],
];

// First match wins within each group; a polyglot repo gets one command per group.
const packageManagers: ReadonlyArray<ReadonlyArray<readonly [string, string]>> =
  [
    [
      ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
      ["bun.lock", "bun install --frozen-lockfile"],
      ["bun.lockb", "bun install --frozen-lockfile"],
      ["yarn.lock", "yarn install --frozen-lockfile"],
      ["package-lock.json", "npm ci"],
    ],
    [
      ["uv.lock", "uv sync --frozen"],
      ["poetry.lock", "poetry install"],
    ],
    [["Gemfile.lock", "bundle install"]],
  ];

export function inferPostCreate(dir: string): string[] {
  const commands: string[] = [];
  for (const [file, command] of toolSetups) {
    if (existsSync(path.join(dir, file))) {
      commands.push(command);
      break;
    }
  }
  for (const group of packageManagers) {
    for (const [file, command] of group) {
      if (existsSync(path.join(dir, file))) {
        commands.push(command);
        break;
      }
    }
  }
  if (existsSync(path.join(dir, ".pre-commit-config.yaml"))) {
    commands.push("pre-commit install");
  }
  return commands;
}

export function detectCopyFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter(
      (file) =>
        (file === ".env" || file.startsWith(".env.")) &&
        !file.endsWith(".example") &&
        !file.endsWith(".sample"),
    )
    .sort();
}

export function generateTargetConfig(
  copy: string[],
  postCreate: string[],
): string {
  const doc = new Document({ worktree: { copy, post_create: postCreate } });
  doc.commentBefore =
    " Scaffolded by `jigs bind`. Worktree provisioning for this repo.";
  const text = doc.toString();
  // The yaml lib pushes an empty flow seq onto its own line when commented.
  return copy.length === 0
    ? text.replace(
        "copy: []",
        "copy: [] # files copied into each worktree, e.g. .env",
      )
    : text;
}
