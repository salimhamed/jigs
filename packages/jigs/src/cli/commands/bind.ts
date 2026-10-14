import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { upsertBinding } from "../../config/config-edit.ts";
import { readFactoryConfigText, writeFactoryConfigText } from "../../config/factory-config.ts";
import { currentFactoryContext } from "../../config/factory-context.ts";
import { JigsError } from "../../errors.ts";
import { parseGithubRemote } from "../../providers/github-remote.ts";
import { hasBindingClone } from "../../steps/workspaces/clone.ts";
import { bindingFilesDir, cloneDir, cloneRepoDir } from "../../steps/workspaces/layout.ts";
import { installationNameSchema } from "../../workflow/factory-schema.ts";
import { detail, hint } from "../output.ts";

const BINDING_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface BindDeps {
  out: (line: string) => void;
}

export interface BindOptions {
  name?: string;
  /** The GitHub App installation, as named on the hub, that reaches the repository. */
  installation?: string;
}

export interface BindResult {
  name: string;
  remote: string;
  installationName: string;
}

// A config edit only. The clone is the service's to make at its next start.
export function bindRepo(remoteUrl: string, deps: BindDeps, options: BindOptions = {}): BindResult {
  const ctx = currentFactoryContext();
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
  const installationName = options.installation ?? existing?.installationName;
  if (installationName === undefined) {
    throw new JigsError(
      `bind needs the GitHub installation that reaches ${remoteUrl}`,
      `name it as the hub does: \`pnpm exec jigs bind ${remoteUrl} --installation <installation-name>\``,
    );
  }
  if (!installationNameSchema.safeParse(installationName).success) {
    throw new JigsError(
      `invalid installation name ${JSON.stringify(installationName)}`,
      "an installation name is lowercase letters, digits and hyphens, starting with a letter, as named on the hub",
    );
  }
  const updated = upsertBinding(text, name, { remote: remoteUrl, installationName });

  if (updated !== text) {
    writeFactoryConfigText(factoryRoot, updated);
  }
  deps.out(
    existing === undefined
      ? `bound ${name} → ${remoteUrl} through ${installationName}`
      : updated === text
        ? `${name} already points at ${remoteUrl} through ${installationName}`
        : `${name} now points at ${remoteUrl} through ${installationName}`,
  );
  if (createBindingFilesDir(factoryRoot, name)) {
    deps.out(
      `created bindings/${name}/ ${detail("files the binding's copy lists go into each worktree")}`,
    );
  }
  // A new entry has nothing cloned yet, or — after the unbind a repoint takes
  // — the old repo's objects sitting where its clone goes.
  const owesClone =
    existing === undefined || !hasBindingClone(cloneRepoDir({ factoryRoot, bindingName: name }));
  if (owesClone) {
    for (const line of [
      "",
      ...hint(`to apply the config and clone ${name}, run:`, "pnpm exec jigs up"),
    ]) {
      deps.out(line);
    }
  }
  return { name, remote: remoteUrl, installationName };
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
