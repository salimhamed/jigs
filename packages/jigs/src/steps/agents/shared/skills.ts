import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { currentFactoryContext, jigsDataDir } from "../../../config/factory-context.ts";
import { JigsError } from "../../../errors.ts";

/** The folder a declared skill path names: absolute as given, otherwise under the factory root. */
export function skillFolder(
  entry: string,
  root: () => string = () => currentFactoryContext().root,
): string {
  return path.isAbsolute(entry) ? path.resolve(entry) : path.resolve(root(), entry);
}

/**
 * The skill name a folder lands under, which is its basename. A resolved path ends in a real
 * name unless it is the filesystem root, which names no skill.
 */
export function skillName(folder: string): string | undefined {
  const name = path.basename(folder);
  return name === "" ? undefined : name;
}

// cpSync's dereference leaves nested links as links, so the walk follows them itself.
function copyTree(source: string, target: string, ancestors: ReadonlySet<string>): void {
  const real = realpathSync(source);
  if (ancestors.has(real)) throw new JigsError(`${source} links back into a folder that holds it`);
  const inside = new Set([...ancestors, real]);
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source)) {
    const from = path.join(source, entry);
    const to = path.join(target, entry);
    const stats = statSync(from);
    if (stats.isDirectory()) copyTree(from, to, inside);
    else if (stats.isFile()) copyFileSync(from, to);
    else throw new JigsError(`${from} is neither a file nor a folder`);
  }
}

/**
 * Copy each declared skill folder to `<destination>/<name>` and return the copies. Links are
 * followed and copied as files, so nothing an agent writes there reaches the factory.
 */
export function copySkills(
  skills: readonly string[],
  destination: string,
  root: () => string = () => currentFactoryContext().root,
): string[] {
  const copied = new Map<string, string>();
  for (const entry of skills) {
    const source = skillFolder(entry, root);
    const name = skillName(source);
    if (name === undefined) throw new JigsError(`${entry} names no skill folder`);
    const earlier = copied.get(name);
    if (earlier !== undefined) {
      throw new JigsError(
        `skill folders ${earlier} and ${source} are both named ${name}`,
        "rename one of the folders so every declared skill has its own name",
      );
    }
    const target = path.join(destination, name);
    try {
      copyTree(source, target, new Set());
    } catch (err) {
      throw new JigsError(
        `could not copy the skill ${entry}: ${err instanceof Error ? err.message : String(err)}`,
        "fix the skill folder so it holds only readable files and folders",
      );
    }
    copied.set(name, source);
  }
  return [...copied.keys()].map((name) => path.join(destination, name));
}

export const CLAUDE_SKILLS_PLUGIN = "jigs-skills";

export interface SkillsPlugin {
  path: string;
  cleanup(): void;
}

export interface SkillsPluginOptions {
  baseDir?: string;
  root?: () => string;
}

/** Return the per-run folder that holds a run's Claude skills plugins. */
export function claudePluginsPath(runId: string, options: SkillsPluginOptions = {}): string {
  return path.join(options.baseDir ?? path.join(jigsDataDir(), "claude-plugins"), runId);
}

/**
 * Build a private Claude Code plugin holding copies of the declared skills, for one agent call.
 * Claude Code lists them as `jigs-skills:<name>`.
 */
export function prepareClaudeSkillsPlugin(
  runId: string,
  skills: readonly string[],
  options: SkillsPluginOptions = {},
): SkillsPlugin {
  const runDir = claudePluginsPath(runId, options);
  mkdirSync(runDir, { recursive: true });
  const dir = mkdtempSync(path.join(runDir, "plugin-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    mkdirSync(path.join(dir, ".claude-plugin"));
    writeFileSync(
      path.join(dir, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: CLAUDE_SKILLS_PLUGIN, description: "Skills declared by the workflow" }, null, 2)}\n`,
    );
    copySkills(skills, path.join(dir, "skills"), options.root);
  } catch (error) {
    cleanup();
    throw error;
  }
  return { path: dir, cleanup };
}
