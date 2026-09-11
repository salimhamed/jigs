import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { interpolate } from "../../blocks/interpolate.ts";
import { JigsError } from "../../errors.ts";
import { locateTemplates, packageRoot, TEMPLATE_SUFFIX } from "../templates.ts";

// Scaffolds a factory repo: the infrastructure a factory needs to build and
// run its own service, plus the code it starts from — the step wrappers, a
// ship pipeline, jigs.config.ts and its ids test. Every file is written once
// and never rewritten: from then on the factory owns it, and the wrapper file
// in particular is half of every step id it declares. Nothing that touches
// the machine runs here; `jigs up` is that, one step at a time.

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
    "pipelines/, steps/jigs.ts, blocks/ and prompts/ are yours now: edit freely, but renaming or moving an exported wrapper changes its step id — do that only when jigs ps shows no parked runs",
  );
  deps.out("");
  deps.out("next, in this directory:");
  deps.out(
    "  cp .env.example .env    # then fill in LINEAR_API_KEY and GITHUB_TOKEN",
  );
  deps.out(
    "  # the install reads @salimhamed/* from GitHub Packages — ~/.npmrc needs",
  );
  deps.out(
    "  #   //npm.pkg.github.com/:_authToken=<a token with read:packages>",
  );
  deps.out(
    "  jigs up                 # install, World, bootstrap, build, start, doctor",
  );
  deps.out("  jigs bind <remote-url>  # then jigs service restart to clone it");

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

// Pinned to the exact version of the CLI that scaffolded it, never a range:
// the jigs that compiles a factory's pipelines has to be the one its service
// runs, and only one install can be both.
function jigsVersion(): string {
  const manifest = JSON.parse(
    readFileSync(path.join(packageRoot(), "package.json"), "utf8"),
  ) as { version: string };
  return manifest.version;
}
