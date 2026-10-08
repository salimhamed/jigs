import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { type ResolvedService, resolveService } from "../../config/factory-config.ts";
import { readFactoryEnv } from "../../config/factory-env.ts";
import { JigsError } from "../../errors.ts";
import { stringEnv } from "../../steps/agents/shared/env.ts";
import { type ExecFile, execOrExplain, execOutput, nodeExecFile } from "../exec.ts";
import { factoryContextAt } from "../factory-context.ts";
import { columns, detail, displayPath, hint, section, tone } from "../output.ts";
import { buildFactoryService, type Prepare } from "./build.ts";
import { dockerCompose, factoryName, postgresNames } from "./compose.ts";
import { runDoctor } from "./doctor.ts";
import {
  awaitServiceReady,
  ensureServiceCurrent,
  liveServicePid,
  type ServiceOutcome,
} from "./service.ts";
import type { ServiceLifecycleDeps, ServiceProcesses } from "./service-process.ts";
import { serviceLogPath } from "./service-record.ts";
import { nested, type Step, StepFailed, stepRunner } from "./step-runner.ts";

// Where the Workflow SDK's Nitro builder records the IDs it compiled.
export const BUILD_MANIFEST = "node_modules/.nitro/workflow/manifest.json";

// Takes a factory from any state to a running service: the commands a human
// used to type after `jigs init`, run in order. Each step is idempotent, so a
// second `up` on an unchanged factory installs, migrates and restarts
// nothing.

export type UpStepName =
  | "locate"
  | "env"
  | "install"
  | "compose"
  | "bootstrap"
  | "build"
  | "service"
  | "ready"
  | "doctor";

export type UpStep = Step<UpStepName>;

export interface UpResult {
  ok: boolean;
  steps: UpStep[];
  factoryRoot?: string;
  serviceUrl?: string;
  dashboardUrl?: string;
  service?: ServiceOutcome;
}

export interface UpDeps {
  cwd: string;
  out: (line: string) => void;
  execFile?: ExecFile;
  processes?: ServiceProcesses;
  prepare?: Prepare;
  migrate?: (url: string) => Promise<void>;
  runsInFlight?: (worldUrl: string) => Promise<InFlightRun[]>;
  confirm?: (question: string) => Promise<boolean>;
  readyTimeoutMs?: number;
}

export interface UpOptions {
  restart?: boolean;
  force?: boolean;
  doctor?: boolean;
}

export async function upFactory(deps: UpDeps, options: UpOptions = {}): Promise<UpResult> {
  const execFile = deps.execFile ?? nodeExecFile;
  const runner = stepRunner<UpStepName>(deps.out);
  const result: UpResult = { ok: false, steps: runner.steps };

  try {
    const { factoryRoot, service } = await runner.run("locate", (note) => {
      const located = locate(deps.cwd);
      note(located.factoryRoot);
      return located;
    });
    result.factoryRoot = factoryRoot;
    result.serviceUrl = service.serviceUrl;
    result.dashboardUrl = service.dashboardUrl;
    const lifecycle: ServiceLifecycleDeps = {
      cwd: factoryRoot,
      out: nested(deps.out),
      processes: deps.processes,
      startTimeoutMs: deps.readyTimeoutMs,
    };

    const env = await runner.run("env", () => ensureEnv(factoryRoot));

    await runner.run("install", () =>
      execOrExplain(execFile, "pnpm", ["install"], { cwd: factoryRoot }, deps.out, {
        missing: new JigsError("pnpm is not on PATH", "install pnpm: https://pnpm.io/installation"),
        failed: () =>
          new JigsError(`pnpm install failed in ${factoryRoot}`, "the output above is pnpm's"),
      }),
    );

    await runner.run("compose", () =>
      dockerCompose(execFile, factoryRoot, ["up", "-d", "--wait"], deps.out),
    );

    const worldUrl = await runner.run("bootstrap", async () => {
      const url = await bootstrapWorld(execFile, factoryRoot, env, deps.out);
      const migrate =
        deps.migrate ?? (await import("../../steps/runtime/registry.ts")).migrateRegistry;
      await migrate(url);
      return url;
    });

    await runner.run("build", () =>
      buildFactoryService({
        cwd: factoryRoot,
        out: nested(deps.out),
        execFile,
        prepare: deps.prepare,
      }),
    );

    // The spawn and the wait are two steps here, so each gets its own line
    // and its own failure; the wait itself is the one `jigs service start`
    // does.
    result.service = await runner.run("service", async (note) => {
      const inFlight = await (deps.runsInFlight ?? runsInFlight)(worldUrl);
      refuseStrandedRuns(inFlight, factoryRoot, deps.out);
      const outcome = await ensureServiceCurrent(lifecycle, {
        restart: options.restart,
        beforeRestart: () => confirmRestart(inFlight, service, deps, options),
      });
      if (outcome === "unchanged") note("unchanged, not restarted");
      return outcome;
    });

    await runner.run("ready", () => awaitServiceReady(lifecycle));

    if (options.doctor === false) {
      runner.skip("doctor", "--no-doctor");
    } else {
      await runner.run("doctor", async () => {
        try {
          await runDoctor({
            serviceUrl: service.serviceUrl,
            out: nested(deps.out),
          });
        } catch (err) {
          if (err instanceof JigsError && err.hint === undefined) {
            throw new JigsError(err.message, "each failing check above names its own repair");
          }
          throw err;
        }
      });
    }

    await printSummary(execFile, factoryRoot, service, liveServicePid(lifecycle), deps.out);
    result.ok = true;
    return result;
  } catch (err) {
    if (err instanceof StepFailed) return result;
    throw err;
  }
}

function locate(cwd: string): { factoryRoot: string; service: ResolvedService } {
  const ctx = factoryContextAt(cwd);
  return { factoryRoot: ctx.root, service: resolveService(ctx) };
}

// Never copied for the operator: a .env is where they decide which
// credentials this factory holds.
function ensureEnv(factoryRoot: string): Record<string, string> {
  if (!existsSync(path.join(factoryRoot, ".env"))) {
    if (!existsSync(path.join(factoryRoot, ".env.example"))) {
      throw new JigsError(
        `no .env or .env.example in ${factoryRoot}`,
        "scaffold one: `pnpm exec jigs init`",
      );
    }
    throw new JigsError(
      `no .env in ${factoryRoot}`,
      "copy .env.example, then fill in what your workflows need: `cp .env.example .env`",
    );
  }
  const env = readFactoryEnv(factoryRoot);
  // The service refuses to start without it, so nothing after this step could work.
  if ((env.JIGS_HUB_TOKEN ?? "") === "") {
    throw new JigsError(
      "JIGS_HUB_TOKEN is not set in .env",
      "connect the factory with the token the hub showed when you added it: `pnpm exec jigs hub connect <url> <token>`",
    );
  }
  return env;
}

// The World URL travels in the child's environment explicitly, never left to
// bootstrap's own .env lookup: unset, it silently migrates
// postgres://localhost:5432/world, which is nobody's factory.
async function bootstrapWorld(
  execFile: ExecFile,
  factoryRoot: string,
  env: Record<string, string>,
  out: (line: string) => void,
): Promise<string> {
  const url = env.WORKFLOW_POSTGRES_URL;
  if (url === undefined || url === "") {
    throw new JigsError(
      "WORKFLOW_POSTGRES_URL is not set in .env",
      "set it to this factory's World, in the shape .env.example shows",
    );
  }
  const bin = path.join(factoryRoot, "node_modules", ".bin", "bootstrap");
  if (!existsSync(bin)) {
    throw new JigsError(
      `no bootstrap in ${path.dirname(bin)}`,
      "pnpm install did not install @workflow/world-postgres\nadd it to this factory's package.json",
    );
  }
  await execOrExplain(
    execFile,
    bin,
    [],
    {
      cwd: factoryRoot,
      env: { ...stringEnv(), ...env, WORKFLOW_POSTGRES_URL: url },
    },
    out,
    {
      missing: new JigsError(`${bin} is not executable`, "install again: `pnpm install`"),
      failed: (err) =>
        /ECONNREFUSED/.test(execOutput(err))
          ? new JigsError(
              `bootstrap could not reach the World at ${redactPassword(url)}`,
              `docker-compose.yml publishes ${publishedPostgresPorts(factoryRoot)}, and the two have to agree`,
            )
          : new JigsError("bootstrap failed", "the output above is @workflow/world-postgres's"),
    },
  );
  return url;
}

// One Postgres container and one Node process, which also serves the
// dashboard on its second port: every running thing, and the one command
// that stops them all.
async function printSummary(
  execFile: ExecFile,
  factoryRoot: string,
  service: ResolvedService,
  pid: number | undefined,
  out: (line: string) => void,
): Promise<void> {
  const ports = postgresPorts(factoryRoot);
  const { container } = await postgresNames(execFile, factoryRoot);
  const rows: Array<[string, string]> = [
    [
      "postgres",
      `${ports.length === 0 ? "no published port" : ports.map((port) => `localhost:${port}`).join(", ")}${container === undefined ? "" : ` ${detail(`Docker container ${container}`)}`}`,
    ],
    ["service", `${service.serviceUrl} ${detail(`pid ${pid ?? "unknown"}`)}`],
    ["dashboard", service.dashboardUrl],
    ["logs", displayPath(serviceLogPath(service.slug))],
  ];
  const summary = section(`${factoryName(factoryRoot)} is up`, [
    ...columns(rows),
    ...hint("stop everything:", "pnpm exec jigs down"),
  ]);
  for (const line of ["", ...summary]) out(line);
}

function redactPassword(url: string): string {
  return url.replace(/\/\/([^:/@]+):[^@]*@/, "//$1:***@");
}

function postgresPorts(factoryRoot: string): string[] {
  const compose = readFileSync(path.join(factoryRoot, "docker-compose.yml"), "utf8");
  return [...compose.matchAll(/"?(\d+):5432"?/g)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1]],
  );
}

function publishedPostgresPorts(factoryRoot: string): string {
  const ports = postgresPorts(factoryRoot);
  return ports.length === 0 ? "no port for 5432" : `:${ports.join(", :")}`;
}

export interface InFlightRun {
  runId: string;
  workflow: string;
  status: string;
  steps: string[];
}

// Read from the World, not the service: the service may be stopped, or on
// another jigs whose run listing this CLI cannot read.
async function runsInFlight(worldUrl: string): Promise<InFlightRun[]> {
  const { Client } = (await import("pg")).default;
  const client = new Client({ connectionString: worldUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{
      id: string;
      name: string;
      status: string;
      steps: string[];
    }>(
      `select r.id, r.name, r.status,
         array_remove(array_agg(distinct s.step_name), null) as steps
       from "workflow"."workflow_runs" r
       left join "workflow"."workflow_steps" s on s.run_id = r.id
       where r.status in ('pending', 'running')
       group by r.id, r.name, r.status, r.created_at
       order by r.created_at`,
    );
    return rows.map((row) => ({
      runId: row.id,
      workflow: row.name,
      status: row.status,
      steps: row.steps,
    }));
  } finally {
    await client.end();
  }
}

// A waiting or running run replays its workflow and recorded steps by ID, and
// fails on one the new build no longer has. Only factory-local IDs: the SDK's
// own are its contract.
function refuseStrandedRuns(
  runs: InFlightRun[],
  factoryRoot: string,
  out: (line: string) => void,
): void {
  if (runs.length === 0) return;
  type Entries = Record<string, Record<string, { stepId?: string; workflowId?: string }>>;
  const manifest = JSON.parse(readFileSync(path.join(factoryRoot, BUILD_MANIFEST), "utf8")) as {
    steps: Entries;
    workflows: Entries;
  };
  const built = new Set(
    [...Object.values(manifest.steps), ...Object.values(manifest.workflows)].flatMap((file) =>
      Object.values(file).map((entry) => entry.stepId ?? entry.workflowId),
    ),
  );
  const stranded = runs.flatMap((run) => {
    const missing = [run.workflow, ...run.steps].filter(
      (id) => /^(?:step|workflow)\/\/\.\//.test(id) && !built.has(id),
    );
    return missing.length === 0 ? [] : [{ run, missing }];
  });
  if (stranded.length === 0) return;
  for (const { run, missing } of stranded) out(`  ${run.runId}: ${missing.join(", ")}`);
  throw new JigsError(
    `${stranded.length} run(s) need workflows or steps this build no longer has`,
    "put back the previous jigs version and code, then `pnpm install` and `pnpm exec jigs up`\nlet those runs finish, or cancel each: `pnpm exec jigs cancel <run-id>`\nthen try the change again",
  );
}

async function confirmRestart(
  inFlight: InFlightRun[],
  service: ResolvedService,
  deps: UpDeps,
  options: UpOptions,
): Promise<void> {
  if (inFlight.length === 0) return;
  // Warned even under --force: a restart cuts off active steps.
  deps.out(
    `  warning: ${inFlight.length} run(s) parked or active; a restart cuts off active steps, and parked runs resume on the new bundle:`,
  );
  for (const line of columns(inFlight.map((run) => [run.runId, run.workflow, tone(run.status)]))) {
    deps.out(`    ${line}`);
  }
  const runs = `${inFlight.length} in-flight run(s)`;
  if (options.force === true) return;
  if (deps.confirm === undefined) {
    throw new JigsError(
      `refusing to restart ${service.slug} over ${runs} without confirmation`,
      "restart anyway: `pnpm exec jigs up --force`\nor cancel each run first: `pnpm exec jigs cancel <run-id>`",
    );
  }
  if (!(await deps.confirm(`restart ${service.slug} over ${runs}?`))) {
    throw new JigsError(
      "restart declined, so the service still runs the previous bundle",
      "when the runs finish, run: `pnpm exec jigs up`",
    );
  }
}
