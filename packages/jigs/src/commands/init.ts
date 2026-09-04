import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { locateTemplates, TEMPLATE_SUFFIX } from "../config/templates.ts";
import { CliError } from "../errors.ts";
import { interpolate } from "../prompts/interpolate.ts";

// Scaffolds a factory repo: the infrastructure a factory needs to build and
// run its own service. Nothing a pipeline is written in — jigs.config.ts, the
// pipelines, the step wrappers — is written here; a factory owns its own code.
// Everything that touches the machine — docker, the World schema, the build,
// the service — is printed, never run. Those are the steps a human has to be
// able to see fail.

export interface InitDeps {
  cwd: string;
  out: (line: string) => void;
  templatesDir?: string;
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
  const templates = deps.templatesDir ?? locateTemplates();
  const ports = factoryPorts(root);
  const values: Record<string, string> = {
    FACTORY_NAME: factoryName(root),
    JIGS_REPO: path.resolve(templates, "..", "..", ".."),
    SERVICE_PORT: String(ports.servicePort),
    DASHBOARD_PORT: String(ports.dashboardPort),
    POSTGRES_PORT: String(ports.postgresPort),
  };

  const created: string[] = [];
  const skipped: string[] = [];
  for (const relative of templateFiles(templates)) {
    const destination = path.join(
      root,
      relative.slice(0, -TEMPLATE_SUFFIX.length),
    );
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
    "write this factory's own jigs.config.ts, pipelines/ and steps/jigs.ts — jigs scaffolds none of them",
  );
  deps.out("");
  deps.out("next, in this directory (jigs runs none of these for you):");
  deps.out("  cp .env.example .env");
  deps.out("  pnpm install");
  deps.out("  docker compose up -d --wait");
  deps.out("  # bootstrap does not read .env, so pass the World URL:");
  deps.out(
    `  WORKFLOW_POSTGRES_URL=postgres://jigs:jigs@localhost:${ports.postgresPort}/jigs pnpm exec bootstrap`,
  );
  deps.out("  jigs build");
  deps.out("  jigs service start");

  return { created, skipped, ...ports };
}

// Two factories on one machine must not fight over a port or a container. The
// offset is derived from the factory's path, so a factory always gets the
// same pair back.
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
    throw new CliError(
      `${factoryRoot} has no usable name for a docker project`,
      `run jigs init from a directory named in [a-z0-9-]`,
    );
  }
  return name;
}

function templateFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory())
      return templateFiles(path.join(dir, entry.name), relative);
    return entry.name.endsWith(TEMPLATE_SUFFIX) ? [relative] : [];
  });
}
