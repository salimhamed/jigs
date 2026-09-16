import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { interpolate } from "../../blocks/interpolate.ts";
import type { MergePolicy } from "../../blocks/pull-request/policy.ts";
import type { GithubIdentity } from "../../config/factory-config.ts";
import { JigsError } from "../../errors.ts";
import { locateTemplates, packageRoot, TEMPLATE_SUFFIX } from "../templates.ts";

// Scaffolds infrastructure, editable factory code, and the committed generated
// integration. Existing files are preserved; `jigs generate` explicitly
// refreshes jigs.ts. `jigs up` owns operations on the machine.

/** Which GitHub credential the scaffolded factory is written for. */
export type IdentityMode = "pat" | "app";

/** The `--identity app` facts, which have no defaults jigs could invent. */
export interface AppIdentityOptions {
  appId?: string;
  installationId?: string;
  privateKey?: string;
  operator?: string;
  coAuthor?: string;
}

export interface InitDeps {
  cwd: string;
  out: (line: string) => void;
  /** Defaults to `{ mode: "pat" }`: the token an operator already has. */
  identity?: GithubIdentity;
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
  const missing = (["appId", "installationId", "privateKey", "operator"] as const).filter(
    (flag) => options[flag] === undefined || options[flag] === "",
  );
  if (missing.length > 0) {
    throw new JigsError(
      `jigs init --identity app needs ${missing.map((flag) => `--${FLAGS[flag]}`).join(", ")}`,
      'jigs init --identity app --app-id 123 --installation-id 456 --private-key github-app.private-key.pem --operator your-github-login [--co-author "Your Name <you@example.com>"]',
    );
  }
  return {
    mode: "app",
    appId: positiveInt(options.appId, "--app-id"),
    installationId: positiveInt(options.installationId, "--installation-id"),
    privateKeyPath: String(options.privateKey),
    operator: String(options.operator),
    ...(options.coAuthor === undefined ? {} : { coAuthor: options.coAuthor }),
  };
}

const FLAGS = {
  appId: "app-id",
  installationId: "installation-id",
  privateKey: "private-key",
  operator: "operator",
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
  const merge = MERGE_POLICY[identity.mode];
  const values: Record<string, string> = {
    FACTORY_NAME: factoryName(root),
    JIGS_VERSION: jigsVersion(),
    SERVICE_PORT: String(ports.servicePort),
    DASHBOARD_PORT: String(ports.dashboardPort),
    POSTGRES_PORT: String(ports.postgresPort),
    GITHUB_IDENTITY: `  github: {\n${IDENTITY_COMMENT[identity.mode]}\n    identity: ${literal(identity, "    ")},\n  },`,
    MERGE_POLICY: `  merge: ${literal({ ...merge }, "  ", MERGE_COMMENT[identity.mode])},`,
    // The scaffolded test asserts what the scaffolded config declares, and both
    // are written from the one value here, so neither mode can scaffold red.
    GITHUB_EXPECTED: literal({ identity }, "  "),
    MERGE_EXPECTED: literal({ ...merge }, "  "),
  };

  const created: string[] = [];
  const skipped: string[] = [];
  for (const relative of templateFiles(templates)) {
    const destination = path.join(root, relative.slice(0, -TEMPLATE_SUFFIX.length));
    if (existsSync(destination)) {
      skipped.push(path.relative(root, destination));
      continue;
    }
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(
      destination,
      interpolate(readFileSync(path.join(templates, relative), "utf8"), values),
    );
    created.push(path.relative(root, destination));
  }

  for (const file of created.sort()) deps.out(`created ${file}`);
  for (const file of skipped.sort()) deps.out(`kept    ${file}`);

  deps.out("");
  deps.out(
    `${factoryName(root)} listens on :${ports.servicePort}, its dashboard on :${ports.dashboardPort}, its World on :${ports.postgresPort}`,
  );
  deps.out("");
  deps.out(
    "workflows/, blocks/ and custom steps/ are yours; jigs.ts is generated — refresh it with jigs generate and keep custom code outside it",
  );
  deps.out("");
  deps.out(
    identity.mode === "app"
      ? `jigs acts as the App, with ${identity.operator} as the operator; a GitHub review is the approval signal`
      : "jigs acts as you, so GitHub will not let you approve its pull requests — a jigs:approved label is the signal instead",
  );
  deps.out("");
  deps.out("next, in this directory:");
  deps.out(
    identity.mode === "app"
      ? `  chmod 600 ${identity.privateKeyPath}   # and keep it out of git`
      : "  cp .env.example .env    # then fill in LINEAR_API_KEY and GITHUB_TOKEN",
  );
  if (identity.mode === "app") {
    deps.out(
      "  cp .env.example .env    # then fill in LINEAR_API_KEY (the App needs no GITHUB_TOKEN)",
    );
  }
  deps.out("  # the install reads @salimhamed/* from GitHub Packages — ~/.npmrc needs");
  deps.out("  #   //npm.pkg.github.com/:_authToken=<a token with read:packages>");
  deps.out("  jigs up                 # install, World, bootstrap, build, start, doctor");
  deps.out("  jigs doctor             # confirms the credential and prints the merge policy");
  deps.out("  jigs bind <remote-url>  # then jigs service restart to clone it");

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

// Keyed by the key it explains, since the renderer emits them in place.
const MERGE_COMMENT: Record<IdentityMode, Record<string, string>> = {
  pat: { approval: '// "Merge whenever ready": the label survives later pushes.' },
  app: { approval: "// An approving review of the commit; a push withdraws it." },
};

// A TypeScript literal of a plain settings object, on one line while it fits.
function literal(value: unknown, indent: string, comments: Record<string, string> = {}): string {
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  const entries = Object.entries(value);
  const flat = `{ ${entries.map(([key, nested]) => `${key}: ${JSON.stringify(nested)}`).join(", ")} }`;
  const plain = entries.every(([, nested]) => typeof nested !== "object");
  if (plain && flat.length <= 72 && Object.keys(comments).length === 0) return flat;
  const lines = entries.flatMap(([key, nested]) => [
    ...(comments[key] === undefined ? [] : [`${indent}  ${comments[key]}`]),
    `${indent}  ${key}: ${literal(nested, `${indent}  `)},`,
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
      `run jigs init from a directory named in [a-z0-9-]`,
    );
  }
  return name;
}

function templateFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) return templateFiles(path.join(dir, entry.name), relative);
    return entry.name.endsWith(TEMPLATE_SUFFIX) ? [relative] : [];
  });
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
