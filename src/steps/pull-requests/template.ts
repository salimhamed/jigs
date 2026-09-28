import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Worktree } from "../../workflow/workspaces/worktree.ts";

// The places GitHub looks for a default template, in the order it checks them.
const TEMPLATE_DIRECTORIES = [".github", ".", "docs"];

/**
 * Read the repository's default pull request template from the worktree, if it has one.
 *
 * @remarks
 * Looks for `pull_request_template.md` in `.github/`, the repository root and `docs/`, in that
 * order and ignoring case, as GitHub does. Returns `undefined` when there is none or it is empty.
 *
 * @group Read
 */
export async function readPullRequestTemplate(worktree: Worktree): Promise<string | undefined> {
  for (const directory of TEMPLATE_DIRECTORIES) {
    const dir = path.join(worktree.path, directory);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const entry = entries.find(
      (e) => e.isFile() && e.name.toLowerCase() === "pull_request_template.md",
    );
    if (entry === undefined) continue;
    const template = (await readFile(path.join(dir, entry.name), "utf8")).trim();
    return template === "" ? undefined : template;
  }
  return undefined;
}
