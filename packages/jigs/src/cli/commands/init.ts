import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { locateTemplates, packageRoot, TEMPLATE_SUFFIX } from "../../build/templates.ts";
import { JigsError } from "../../errors.ts";
import { interpolate } from "../../workflow/interpolate.ts";
import { copyFiles, reportCopied } from "../copy-files.ts";
import { columns, command, heading, note } from "../output.ts";

// Scaffolds infrastructure and editable factory code. Existing files are
// preserved. `jigs up` owns operations on the machine.

export interface InitDeps {
  cwd: string;
  out: (line: string) => void;
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
  const values: Record<string, string> = {
    FACTORY_NAME: factoryName(root),
    JIGS_VERSION: jigsVersion(),
    SERVICE_PORT: String(ports.servicePort),
    DASHBOARD_PORT: String(ports.dashboardPort),
    POSTGRES_PORT: String(ports.postgresPort),
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
    ["cp .env.example .env", "values every copy of this factory shares"],
    ["cp .env.local.example .env.local", "this copy's own values, such as its ports"],
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
