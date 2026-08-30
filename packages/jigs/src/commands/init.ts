import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  appendBlock,
  missingWrappers,
  STEPS_FILE,
} from "../config/steps-scaffold.ts";
import { locateTemplates, TEMPLATE_SUFFIX } from "../config/templates.ts";
import { CliError } from "../errors.ts";
import { interpolate } from "../prompts/interpolate.ts";

// Scaffolds a factory repo: the files a factory needs to build and run its
// own service. Everything that touches the machine — docker, the World
// schema, the build, the service — is printed, never run. Those are the steps
// a human has to be able to see fail.

export interface InitDeps {
  cwd: string;
  out: (line: string) => void;
  confirm?: (question: string) => Promise<boolean>;
  templatesDir?: string;
}

export interface InitResult {
  created: string[];
  skipped: string[];
  appended: string[];
  servicePort: number;
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

  const appended = await offerMissingWrappers(root, templates, deps);

  deps.out("");
  deps.out(
    `${factoryName(root)} listens on :${ports.servicePort}, its World on :${ports.postgresPort}`,
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

  return { created, skipped, appended, ...ports };
}

/**
 * The whole lifecycle of the scaffold after the first run: this factory keeps
 * every wrapper it has, and is offered the ones jigs has grown since. Nothing
 * regenerates the file — a rewrite would renumber ids the World is already
 * memoizing against.
 */
async function offerMissingWrappers(
  root: string,
  templates: string,
  deps: InitDeps,
): Promise<string[]> {
  const destination = path.join(root, STEPS_FILE);
  const template = readFileSync(
    path.join(templates, `${STEPS_FILE}${TEMPLATE_SUFFIX}`),
    "utf8",
  );
  const existing = readFileSync(destination, "utf8");
  const missing = missingWrappers(template, existing);
  if (missing.length === 0) return [];

  const names = missing.map((wrapper) => wrapper.name);
  deps.out("");
  deps.out(`${STEPS_FILE} has no wrapper for ${names.length} jigs step(s):`);
  for (const name of names) deps.out(`  ${name}`);
  if (deps.confirm === undefined) {
    deps.out("re-run jigs init on a terminal to add them");
    return [];
  }
  if (!(await deps.confirm(`append them to ${STEPS_FILE}?`))) {
    deps.out(`left ${STEPS_FILE} alone`);
    return [];
  }
  appendFileSync(destination, appendBlock(missing, existing));
  deps.out(`appended ${names.length} wrapper(s) to ${STEPS_FILE}`);
  return names;
}

// Two factories on one machine must not fight over a port or a container. The
// offset is derived from the factory's path, so a factory always gets the
// same pair back.
function factoryPorts(factoryRoot: string): {
  servicePort: number;
  postgresPort: number;
} {
  const digest = createHash("sha256").update(factoryRoot).digest();
  const offset = digest.readUInt16BE(0) % 100;
  return { servicePort: 8990 + offset, postgresPort: 5440 + offset };
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
