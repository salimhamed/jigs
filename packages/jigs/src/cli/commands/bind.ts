import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { upsertBinding } from "../../config/config-edit.ts";
import { readFactoryConfigText, writeFactoryConfigText } from "../../config/factory-config.ts";
import { currentFactoryContext } from "../../config/factory-context.ts";
import { JigsError } from "../../errors.ts";
import { bindingFilesDir, cloneDir } from "../../steps/workspaces/layout.ts";
import { installationNameSchema } from "../../workflow/factory-schema.ts";
import { parseGithubRemote } from "../../workflow/github-remote.ts";
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

// A config edit only. A run's first worktree of the binding clones it.
export function bindRepo(remoteUrl: string, deps: BindDeps, options: BindOptions = {}): BindResult {
  const ctx = currentFactoryContext();
  const factoryRoot = ctx.root;
  const repository = parseGithubRemote(remoteUrl);
  if (repository === null) {
    throw new JigsError(
      `${remoteUrl} is not a GitHub repository URL`,
      "for example: `pnpm exec jigs bind git@github.com:owner/repo.git`",
    );
  }

  const { config } = ctx;
  const matchingBindings = Object.entries(config.bindings).filter(
    ([, binding]) => binding.remote === remoteUrl,
  );
  const matchingBinding = matchingBindings[0];
  // Lowercased: the name is typed on a command line.
  const name = options.name ?? matchingBinding?.[0] ?? repository.repo.toLowerCase();
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
  if (updated !== text) {
    for (const line of ["", ...hint("to apply the config, run:", "pnpm exec jigs up")]) {
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
