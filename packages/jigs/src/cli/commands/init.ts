import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { locateTemplates, packageRoot, TEMPLATE_SUFFIX } from "../../build/templates.ts";
import { JigsError } from "../../errors.ts";
import type { LinearIdentity } from "../../workflow/factory-schema.ts";
import { interpolate } from "../../workflow/interpolate.ts";
import { copyFiles, reportCopied } from "../copy-files.ts";
import { columns, command, heading, note } from "../output.ts";

// Scaffolds infrastructure, editable factory code, and the committed generated
// integration. Existing files are preserved; `jigs generate` explicitly
// refreshes jigs/. `jigs up` owns operations on the machine.

export interface InitDeps {
  cwd: string;
  out: (line: string) => void;
  /** Defaults to `{ mode: "key" }`: a personal Linear API key. */
  linearIdentity?: LinearIdentity;
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
  const linearIdentity = deps.linearIdentity ?? { mode: "key" };
  const values: Record<string, string> = {
    FACTORY_NAME: factoryName(root),
    JIGS_VERSION: jigsVersion(),
    SERVICE_PORT: String(ports.servicePort),
    DASHBOARD_PORT: String(ports.dashboardPort),
    POSTGRES_PORT: String(ports.postgresPort),
    LINEAR_IDENTITY: `  linear: {\n${LINEAR_IDENTITY_COMMENT[linearIdentity.mode]}\n    identity: ${literal(linearIdentity, "    ")},\n  },`,
    // The scaffolded test asserts what the scaffolded config declares, and both
    // are written from the one value here, so neither mode can scaffold red.
    LINEAR_EXPECTED: literal({ identity: linearIdentity }, "  "),
  };

  const { created, skipped } = copyFiles(templates, root, {
    suffix: TEMPLATE_SUFFIX,
    contents: (source) => interpolate(source, values),
  });
  reportCopied({ created, skipped }, deps.out);

  deps.out("");
  deps.out(heading("Next, in this directory"));
  const next: Array<[string, string?]> = [
    ["pnpm install"],
    ["cp .env.example .env", "then fill in what your workflows need"],
    ["pnpm exec jigs up", "start Postgres and the service, then run doctor"],
    ["pnpm exec jigs run hello"],
    ["pnpm exec jigs doctor", "re-check what your workflows need, any time"],
  ];
  for (const line of columns(
    next.map(([run, why]) =>
      why === undefined ? [command(run)] : [command(run), note(`# ${why}`)],
    ),
  )) {
    deps.out(`  ${line}`);
  }

  return { created, skipped, ...ports };
}

const LINEAR_IDENTITY_COMMENT: Record<LinearIdentity["mode"], string> = {
  key: "    // jigs acts as the user whose LINEAR_API_KEY is in .env.",
  app: "    // jigs acts as your Linear OAuth app, from LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET in .env.",
};

const literalKey = (key: string): string =>
  /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);

// A TypeScript literal of a plain settings object, on one line while it fits.
function literal(value: unknown, indent: string): string {
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => literal(entry, indent)).join(", ")}]`;
  const entries = Object.entries(value);
  const flat = `{ ${entries.map(([key, nested]) => `${literalKey(key)}: ${JSON.stringify(nested)}`).join(", ")} }`;
  const plain = entries.every(([, nested]) => typeof nested !== "object");
  if (plain && flat.length <= 72) return flat;
  const lines = entries.map(
    ([key, nested]) => `${indent}  ${literalKey(key)}: ${literal(nested, `${indent}  `)},`,
  );
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
      "from a directory whose name uses only [a-z0-9-], run: `pnpm exec jigs init`",
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
