import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { JigsError } from "../../errors.ts";
import { copyFiles, reportCopied } from "../copy-files.ts";
import { packageRoot } from "../templates.ts";

const recipesRoot = () => path.join(packageRoot(), "recipes");

export function recipeNames(): string[] {
  return readdirSync(recipesRoot(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function addRecipe(name: string, deps: { cwd: string; out: (line: string) => void }) {
  if (!recipeNames().includes(name)) {
    throw new JigsError(`unknown recipe: ${name}`, "pnpm exec jigs recipe list");
  }
  const root = path.resolve(deps.cwd);
  if (!existsSync(path.join(root, "jigs.config.ts"))) {
    throw new JigsError(
      "no jigs.config.ts in this directory",
      "run from a factory root, or pnpm exec jigs init first",
    );
  }
  const result = copyFiles(path.join(recipesRoot(), name), root, {
    suffix: "",
    contents: (source) => source,
  });
  reportCopied(result, deps.out);
  deps.out("");
  deps.out("Register the workflow in jigs.config.ts under workflows (if not already present):");
  deps.out(`  ${name}: () => import("./workflows/${name}.ts"),`);
  deps.out(
    "Then run pnpm exec jigs build, pnpm typecheck, and pnpm test. Copied recipe files are yours to edit.",
  );
  return result;
}
