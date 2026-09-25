import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  type GithubIdentity,
  githubIdentitySchema,
  type LinearIdentity,
} from "../../config/factory-config.ts";
import { JigsError } from "../../errors.ts";
import { interpolate } from "../../workflow/interpolate.ts";
import type { MergePolicy } from "../../workflow/pull-requests/policy.ts";
import { copyFiles, reportCopied } from "../copy-files.ts";
import { locateTemplates, packageRoot, TEMPLATE_SUFFIX } from "../templates.ts";

// Scaffolds infrastructure, editable factory code, and the committed generated
// integration. Existing files are preserved; `jigs generate` explicitly
// refreshes jigs/. `jigs up` owns operations on the machine.

/** Which GitHub credential the scaffolded factory is written for. */
export type IdentityMode = "pat" | "app";

/** The `--github-identity-mode app` facts, which have no defaults jigs could invent. */
export interface AppIdentityOptions {
  githubAppId?: string;
  githubAppInstallation?: string[];
  githubAppPrivateKeyPath?: string;
  githubOperatorLogin?: string;
  gitCoAuthor?: string;
}

export interface InitDeps {
  cwd: string;
  out: (line: string) => void;
  /** Defaults to `{ mode: "pat" }`: the token an operator already has. */
  identity?: GithubIdentity;
  /** Defaults to `{ mode: "key" }`: a personal Linear API key. */
  linearIdentity?: LinearIdentity;
}

/**
 * Turn `jigs init`'s flags into the identity the scaffold is written for.
 *
 * App mode is refused rather than stubbed: a scaffold carrying placeholder ids
 * does not load, so the first `jigs up` would fail on a file the operator was
 * never told to finish.
 */
export function resolveIdentityOptions(
  mode: IdentityMode,
  options: AppIdentityOptions,
): GithubIdentity {
  if (mode === "pat") return { mode: "pat" };
  const missing = (
    [
      "githubAppId",
      "githubAppInstallation",
      "githubAppPrivateKeyPath",
      "githubOperatorLogin",
    ] as const
  ).filter((flag) => !options[flag]?.length);
  if (missing.length > 0) {
    throw new JigsError(
      `jigs init --github-identity-mode app needs ${missing.map((flag) => `--${FLAGS[flag]}`).join(", ")}`,
      'pnpm exec jigs init --github-identity-mode app --github-app-id 123 --github-app-installation your-github-login=456 --github-app-private-key-path github-app.private-key.pem --github-operator-login your-github-login [--git-co-author "Your Name <you@example.com>"]',
    );
  }
  const installations: Record<string, number> = {};
  for (const entry of options.githubAppInstallation ?? []) {
    const match = /^([a-zA-Z0-9-]+)=(\d+)$/.exec(entry);
    if (!match)
      throw new JigsError(`--github-app-installation must be <account>=<id>, not ${entry}`);
    const account = match[1] as string;
    if (Object.keys(installations).some((login) => login.toLowerCase() === account.toLowerCase()))
      throw new JigsError(`duplicate --github-app-installation account ${account}`);
    installations[account] = positiveInt(match[2], "--github-app-installation");
  }
  return githubIdentitySchema.parse({
    mode: "app",
    appId: positiveInt(options.githubAppId, "--github-app-id"),
    installations,
    privateKeyPath: String(options.githubAppPrivateKeyPath),
    operator: String(options.githubOperatorLogin),
    ...(options.gitCoAuthor === undefined ? {} : { coAuthor: options.gitCoAuthor }),
  });
}

const FLAGS = {
  githubAppId: "github-app-id",
  githubAppInstallation: "github-app-installation",
  githubAppPrivateKeyPath: "github-app-private-key-path",
  githubOperatorLogin: "github-operator-login",
} as const;

function positiveInt(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new JigsError(`${flag} must be a positive whole number, not ${value}`);
  }
  return parsed;
}

export interface InitResult {
  created: string[];
  skipped: string[];
  servicePort: number;
  dashboardPort: number;
  postgresPort: number;
}

export async function initFactory(deps: InitDeps): Promise<InitResult> {
  const root = path.resolve(deps.cwd);
  const templates = locateTemplates();
  const ports = factoryPorts(root);
  const identity = deps.identity ?? { mode: "pat" };
  const linearIdentity = deps.linearIdentity ?? { mode: "key" };
  const merge = MERGE_POLICY[identity.mode];
  const values: Record<string, string> = {
    FACTORY_NAME: factoryName(root),
    JIGS_VERSION: jigsVersion(),
    SERVICE_PORT: String(ports.servicePort),
    DASHBOARD_PORT: String(ports.dashboardPort),
    POSTGRES_PORT: String(ports.postgresPort),
    GITHUB_IDENTITY: `  github: {\n${IDENTITY_COMMENT[identity.mode]}\n    identities: [${literal(identity, "    ")}],\n  },`,
    LINEAR_IDENTITY: `  linear: {\n${LINEAR_IDENTITY_COMMENT[linearIdentity.mode]}\n    identity: ${literal(linearIdentity, "    ")},\n  },`,
    MERGE_POLICY: `  merge: ${literal({ ...merge }, "  ", MERGE_COMMENT[identity.mode])},`,
    // The scaffolded test asserts what the scaffolded config declares, and both
    // are written from the one value here, so neither mode can scaffold red.
    GITHUB_EXPECTED: literal({ identities: [identity] }, "  "),
    LINEAR_EXPECTED: literal({ identity: linearIdentity }, "  "),
    MERGE_EXPECTED: literal({ ...merge }, "  "),
  };

  const { created, skipped } = copyFiles(templates, root, {
    suffix: TEMPLATE_SUFFIX,
    contents: (source) => interpolate(source, values),
  });
  reportCopied({ created, skipped }, deps.out);

  deps.out("");
  deps.out("next, in this directory:");
  if (identity.mode === "app") {
    deps.out(`  chmod 600 ${identity.privateKeyPath}   # and keep it out of git`);
  }
  deps.out("  pnpm install");
  deps.out("  cp .env.example .env    # then fill in what your workflows need");
  deps.out("  pnpm exec jigs up       # start Postgres and the service; ends by running doctor");
  deps.out("  pnpm exec jigs run hello");
  deps.out("  pnpm exec jigs doctor   # re-check what your workflows need, any time");

  return { created, skipped, ...ports };
}

// Written out in full rather than left to a default, because the approval
// signal has to match the identity and nothing derives one from the other at
// run time: a personal token makes jigs the pull request's author, and GitHub
// refuses to let an author approve their own, so a label is the only consent
// the operator can give. An App is a different author, so a review works.
const MERGE_POLICY: Record<IdentityMode, MergePolicy> = {
  pat: {
    by: "human",
    method: "squash",
    // "Merge whenever ready": the label survives later pushes.
    approval: { kind: "label", name: "jigs:approved" },
  },
  app: { by: "human", method: "squash", approval: { kind: "review" } },
};

const IDENTITY_COMMENT: Record<IdentityMode, string> = {
  pat: "    // jigs acts as you, using GITHUB_TOKEN from .env.",
  app: "    // jigs acts as <app-slug>[bot], minting installation tokens from the key.",
};

const LINEAR_IDENTITY_COMMENT: Record<LinearIdentity["mode"], string> = {
  key: "    // jigs acts as the user whose LINEAR_API_KEY is in .env.",
  app: "    // jigs acts as your Linear OAuth app, from LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET in .env.",
};

// Keyed by the key it explains, since the renderer emits them in place.
const MERGE_COMMENT: Record<IdentityMode, Record<string, string>> = {
  pat: { approval: '// "Merge whenever ready": the label survives later pushes.' },
  app: { approval: "// An approving review of the commit; a push withdraws it." },
};

const literalKey = (key: string): string =>
  /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);

// A TypeScript literal of a plain settings object, on one line while it fits.
function literal(value: unknown, indent: string, comments: Record<string, string> = {}): string {
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => literal(entry, indent)).join(", ")}]`;
  const entries = Object.entries(value);
  const flat = `{ ${entries.map(([key, nested]) => `${literalKey(key)}: ${JSON.stringify(nested)}`).join(", ")} }`;
  const plain = entries.every(([, nested]) => typeof nested !== "object");
  if (plain && flat.length <= 72 && Object.keys(comments).length === 0) return flat;
  const lines = entries.flatMap(([key, nested]) => [
    ...(comments[key] === undefined ? [] : [`${indent}  ${comments[key]}`]),
    `${indent}  ${literalKey(key)}: ${literal(nested, `${indent}  `)},`,
  ]);
  return `{\n${lines.join("\n")}\n${indent}}`;
}

// A starting point a factory always gets back, since the offset is derived
// from its path. Two factories can still land on the same offset, and the
// operator edits the ports from there.
function factoryPorts(factoryRoot: string): {
  servicePort: number;
  dashboardPort: number;
  postgresPort: number;
} {
  const digest = createHash("sha256").update(factoryRoot).digest();
  const offset = digest.readUInt16BE(0) % 100;
  // Three disjoint ranges, one offset: a dashboard port next to the service
  // port would be another factory's service port whenever their offsets
  // differ by one.
  return {
    servicePort: 8990 + offset,
    dashboardPort: 9090 + offset,
    postgresPort: 5440 + offset,
  };
}

function factoryName(factoryRoot: string): string {
  const name = path
    .basename(factoryRoot)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (name === "") {
    throw new JigsError(
      `${factoryRoot} has no usable name for a docker project`,
      `run pnpm exec jigs init from a directory named in [a-z0-9-]`,
    );
  }
  return name;
}

// Pinned to the exact version of the CLI that scaffolded it, never a range:
// the jigs that compiles a factory's workflows has to be the one its service
// runs, and only one install can be both.
function jigsVersion(): string {
  const manifest = JSON.parse(readFileSync(path.join(packageRoot(), "package.json"), "utf8")) as {
    version: string;
  };
  return manifest.version;
}
