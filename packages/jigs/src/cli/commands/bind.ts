import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { upsertBinding } from "../../config/config-edit.ts";
import { readFactoryConfigText, writeFactoryConfigText } from "../../config/factory-config.ts";
import type { FactoryContext } from "../../config/factory-context.ts";
import { JigsError } from "../../errors.ts";
import { GitHubApiError } from "../../providers/github-http.ts";
import {
  type EnsureRepoLabelOptions,
  ensureRepoLabel,
  JIGS_LABELS,
} from "../../providers/github-label.ts";
import { parseGithubRemote } from "../../providers/github-remote.ts";
import { hasBindingClone } from "../../steps/workspaces/clone.ts";
import { bindingFilesDir, cloneDir, cloneRepoDir } from "../../steps/workspaces/layout.ts";
import { factoryContextAt } from "../factory-context.ts";
import { detail, hint, note } from "../output.ts";

const BINDING_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface BindDeps {
  cwd: string;
  out: (line: string) => void;
  ensureLabel?: (options: EnsureRepoLabelOptions) => Promise<"created" | "verified">;
}

export interface BindOptions {
  name?: string;
}

export interface BindResult {
  name: string;
  remote: string;
}

// A config edit plus jigs-owned repository furniture: the jigs labels. The clone is the service's to make at its next start.
export async function bindRepo(
  remoteUrl: string,
  deps: BindDeps,
  options: BindOptions = {},
): Promise<BindResult> {
  // The GitHub credential belongs to the factory this verb was typed in, which
  // need not be the one the process's own directory sits in.
  const ctx = factoryContextAt(deps.cwd);
  const factoryRoot = ctx.root;
  // The remote is handed to git in positional slots for the life of the
  // binding, so a leading dash is refused once, here, rather than defended
  // against at every call site.
  if (remoteUrl.startsWith("-")) {
    throw new JigsError(
      `${remoteUrl} starts with a dash, but bind takes a remote URL, not a git option`,
      "for example: `pnpm exec jigs bind git@github.com:owner/repo.git`",
    );
  }
  if (looksLikePath(remoteUrl)) {
    throw new JigsError(
      `${remoteUrl} looks like a path, but bind takes a remote URL`,
      "for example: `pnpm exec jigs bind git@github.com:owner/repo.git`\na repo on this machine is a URL too: file:///srv/git/repo.git",
    );
  }

  const { config } = ctx;
  const matchingBindings = Object.entries(config.bindings).filter(
    ([, binding]) => binding.remote === remoteUrl,
  );
  const matchingBinding = matchingBindings[0];
  const derivedName = defaultBindingName(remoteUrl);
  const name = options.name ?? matchingBinding?.[0] ?? derivedName;
  if (!BINDING_NAME_PATTERN.test(name)) {
    throw new JigsError(
      `invalid binding name ${JSON.stringify(name)}`,
      "names must match [A-Za-z0-9][A-Za-z0-9._-]*\npass --binding-name to choose one",
    );
  }

  const text = readFactoryConfigText(factoryRoot);
  const existing = Object.hasOwn(config.bindings, name) ? config.bindings[name] : undefined;
  if (existing !== undefined && existing.remote !== remoteUrl) {
    // Repointing silently would fetch an unrelated history into an object
    // store that already holds another repo's.
    throw new JigsError(
      `${name} is already bound to ${existing.remote}`,
      `the clone at ${cloneDir({ factoryRoot, bindingName: name })} holds the old repo's objects\nunbind it, then bind again: \`pnpm exec jigs unbind ${name}\``,
    );
  }
  const updated = upsertBinding(text, name, remoteUrl);

  if (updated !== text) {
    writeFactoryConfigText(factoryRoot, updated);
  }
  deps.out(
    existing === undefined
      ? `bound ${name} → ${remoteUrl}`
      : `${name} already points at ${remoteUrl}`,
  );
  if (createBindingFilesDir(factoryRoot, name)) {
    deps.out(
      `created bindings/${name}/ ${detail("files the binding's copy lists go into each worktree")}`,
    );
  }
  // A new entry has nothing cloned yet, or — after the unbind a repoint takes
  // — the old repo's objects sitting where its clone goes. An entry a failed
  // label leg already wrote owes the clone as much on the re-run.
  const owesClone =
    existing === undefined || !hasBindingClone(cloneRepoDir({ factoryRoot, bindingName: name }));

  // Last, so furniture that cannot be ensured leaves the binding recorded and
  // the whole verb re-runnable: the config edit above and the labels below are
  // idempotent.
  const reBindCommand =
    options.name !== undefined || name !== derivedName
      ? `pnpm exec jigs bind ${remoteUrl} --binding-name ${name}`
      : `pnpm exec jigs bind ${remoteUrl}`;
  // The repair it prints has to land on this binding, not on the one the
  // remote alone would derive.
  await ensureJigsLabels(remoteUrl, ctx, reBindCommand, deps);
  if (owesClone) {
    for (const line of [
      "",
      ...hint(`to apply the config and clone ${name}, run:`, "pnpm exec jigs up"),
    ]) {
      deps.out(line);
    }
  }
  return { name, remote: remoteUrl };
}

// Every label, whatever this factory's approval: a switch to label approval
// later should not need a re-bind of every repository.
async function ensureJigsLabels(
  remoteUrl: string,
  ctx: FactoryContext,
  reBindCommand: string,
  deps: BindDeps,
): Promise<void> {
  const repoRef = parseGithubRemote(remoteUrl);
  if (repoRef === null) {
    deps.out(note(`note: skipping jigs labels (${remoteUrl} is not a github.com remote)`));
    return;
  }
  const slug = `${repoRef.owner}/${repoRef.repo}`;
  for (const label of JIGS_LABELS) {
    const outcome = await (deps.ensureLabel ?? ensureRepoLabel)({
      ...repoRef,
      label,
      context: ctx,
    }).catch((err: unknown) => {
      const rerun = `re-run: \`${reBindCommand}\``;
      const repair = tokenWasRejected(err)
        ? `grant the factory's GitHub App "Issues: read & write", accept it on the installation for ${slug}, then ${rerun}`
        : err instanceof GitHubApiError && err.status === 404
          ? `check the remote, and that the factory's GitHub App installation on ${repoRef.owner} can see ${slug}, then ${rerun}`
          : err instanceof JigsError && err.hint !== undefined
            ? `${err.hint}, then ${rerun}`
            : `once that clears, ${rerun}`;
      throw new JigsError(
        `${slug}'s ${label.name} label could not be ensured: ${err instanceof Error ? err.message : String(err)}`,
        repair,
      );
    });
    deps.out(`label ${outcome}: ${slug}#${label.name}`);
  }
}

// Only a missing folder is created: an existing one may hold secrets the
// operator put there, so nothing inside it is ever rewritten.
function createBindingFilesDir(factoryRoot: string, name: string): boolean {
  const dir = bindingFilesDir(factoryRoot, name);
  if (existsSync(dir)) return false;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "README.md"), bindingFilesReadme(name));
  return true;
}

// Git keeps no empty folder, so the README is what lets it survive a clone.
function bindingFilesReadme(name: string): string {
  return `# bindings/${name}

Files in this folder are copied into each new worktree of the \`${name}\`
binding when they are listed in the binding's \`copy\` option in
\`jigs.config.ts\`. Each file lands at the same relative path in the worktree:
\`bindings/${name}/.env\` arrives as \`.env\` at the worktree root.

The factory's \`.gitignore\` ignores \`.env\` files, so secrets kept here stay
out of git.

See https://salimhamed.github.io/jigs/guide/configuration#bindings
`;
}

// The likeliest operator error, given that bind used to take a checkout path.
function looksLikePath(arg: string): boolean {
  return arg.startsWith(".") || arg.startsWith("/") || arg.startsWith("~") || existsSync(arg);
}

function defaultBindingName(remoteUrl: string): string {
  const repoRef = parseGithubRemote(remoteUrl);
  const last = remoteUrl.split(/[/:]/).filter(Boolean).at(-1) ?? "";
  const repo = repoRef?.repo ?? last.replace(/\.git$/, "");
  // Lowercased: the name is typed on a command line and written into yaml.
  return repo.toLowerCase();
}

// GitHub lays a token it will not take on 401, and one whose scopes fall short
// on 403 — but a rate limit is a 403 too, and no re-issued token clears one.
function tokenWasRejected(err: unknown): boolean {
  if (!(err instanceof GitHubApiError)) return false;
  return err.status === 401 || (err.status === 403 && !/rate limit/i.test(err.body));
}
