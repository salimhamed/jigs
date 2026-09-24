import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { makeTmpDir, removeTmpDir } from "../../test-fixtures.ts";
import {
  closedPort,
  closeFakeServices,
  execError,
  type FakeProcesses,
  fakeExec,
  fakeProcesses,
  fakeService,
  factory as scaffold,
} from "./test-fixtures.ts";
import { type UpDeps, type UpOptions, upFactory } from "./up.ts";

let tmp: string;
let lines: string[];

beforeEach(() => {
  tmp = makeTmpDir();
  lines = [];
  vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  closeFakeServices();
  removeTmpDir(tmp);
});

// With the .env an operator makes from .env.example, which up never copies.
const factory = (shape: Parameters<typeof scaffold>[1]) => {
  const root = scaffold(tmp, shape);
  if (shape.env === undefined && shape.example !== false) {
    copyFileSync(path.join(root, ".env.example"), path.join(root, ".env"));
  }
  return root;
};

function up(
  root: string,
  io: { exec: ReturnType<typeof fakeExec>; procs: FakeProcesses },
  extra: Partial<UpDeps> = {},
  options: UpOptions = {},
) {
  return upFactory(
    {
      cwd: root,
      out: (line) => lines.push(line),
      execFile: io.exec.execFile,
      processes: io.procs.processes,
      prepare: vi.fn(),
      migrate: vi.fn(),
      readyTimeoutMs: 500,
      ...extra,
    },
    options,
  );
}

const statuses = (result: Awaited<ReturnType<typeof upFactory>>) =>
  result.steps.map((step) => `${step.name}:${step.status}`);

test("from a freshly scaffolded factory, every step runs once, in order", async () => {
  const port = await fakeService();
  const root = factory({ port });
  const io = { exec: fakeExec(), procs: fakeProcesses() };

  const result = await up(root, io);

  expect(result.ok).toBe(true);
  expect(statuses(result)).toEqual([
    "locate:ok",
    "env:ok",
    "install:ok",
    "compose:ok",
    "bootstrap:ok",
    "build:ok",
    "service:ok",
    "ready:ok",
    "doctor:ok",
  ]);
  expect(result.service).toBe("started");
  expect(result.serviceUrl).toBe(`http://localhost:${port}`);
  expect(result.dashboardUrl).toBe("http://localhost:9200");

  expect(io.exec.calls.map((call) => [path.basename(call.file), ...call.args])).toEqual([
    ["pnpm", "install"],
    ["docker", "compose", "up", "-d", "--wait"],
    ["bootstrap"],
    ["nitro", "build"],
  ]);
  for (const call of io.exec.calls) expect(call.options.cwd).toBe(root);
  expect(io.procs.spawns).toHaveLength(1);

  // The slots that stay empty are named, not refused.
  const printed = lines.join("\n");
  expect(printed).toMatch(/^ok {3}env \(\d+ms\)$/m);
  expect(printed).toContain("LINEAR_API_KEY, GITHUB_TOKEN empty in .env");
  expect(printed).toMatch(/^ok {3}doctor \(\d+ms\)$/m);
  const [pid] = io.procs.alive;
  const log = io.procs.spawns[0]?.logPath ?? "";
  const slug = path.basename(log, ".log");
  const [postgres, service, dashboard] = [
    "docker compose project acme-factory, port 5555",
    `http://localhost:${port}  pid ${pid}`,
    "dashboard http://localhost:9200",
  ].map((what) => what.padEnd(50));
  expect(lines.slice(-5)).toEqual([
    `${slug} is up`,
    `  postgres   ${postgres}stop: docker compose down`,
    `  service    ${service}stop: pnpm exec jigs service stop`,
    `             ${dashboard}logs ${log}`,
    "  stop everything: pnpm exec jigs down",
  ]);
});

test("an app Linear identity names its client variables as the empty slots", async () => {
  const port = await fakeService();
  const root = factory({ port, linearIdentity: "app" });
  const io = { exec: fakeExec(), procs: fakeProcesses() };
  expect((await up(root, io)).ok).toBe(true);
  expect(lines.join("\n")).toContain(
    "LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET, GITHUB_TOKEN empty in .env",
  );
});

test("bootstrap is handed the World URL from .env explicitly", async () => {
  const port = await fakeService();
  const root = factory({ port });
  const io = { exec: fakeExec(), procs: fakeProcesses() };

  const migrate = vi.fn(async (url: string) => {
    expect(io.exec.calls.some((call) => path.basename(call.file) === "bootstrap")).toBe(true);
    expect(url).toBe("postgres://jigs:jigs@localhost:5555/jigs");
  });
  await up(root, io, { migrate });
  expect(migrate).toHaveBeenCalledOnce();

  const bootstrap = io.exec.calls.find((call) => path.basename(call.file) === "bootstrap");
  expect(bootstrap?.options.env?.WORKFLOW_POSTGRES_URL).toBe(
    "postgres://jigs:jigs@localhost:5555/jigs",
  );
});

test("a second up on an unchanged factory leaves the running service alone", async () => {
  const port = await fakeService();
  const root = factory({ port });
  const io = { exec: fakeExec(), procs: fakeProcesses() };
  await up(root, io);
  lines = [];

  const again = await up(root, io);

  expect(again.ok).toBe(true);
  expect(again.service).toBe("unchanged");
  expect(io.procs.spawns).toHaveLength(1);
  expect(io.procs.signals.map((s) => s.sig)).not.toContain("SIGTERM");
  expect(lines.join("\n")).toMatch(/^ok {3}service .* — unchanged, not restarted$/m);
});

test("a changed bundle restarts the service; --restart-service forces one", async () => {
  const port = await fakeService();
  const root = factory({ port });
  const io = { exec: fakeExec(), procs: fakeProcesses() };
  await up(root, io);

  io.exec.bundle = "bundle v2";
  const changed = await up(root, io);
  expect(changed.service).toBe("restarted");
  expect(io.procs.spawns).toHaveLength(2);
  expect(io.procs.signals.filter((s) => s.sig === "SIGTERM")).toHaveLength(1);

  const forced = await up(root, io, {}, { restart: true });
  expect(forced.service).toBe("restarted");
  expect(io.procs.spawns).toHaveLength(3);
});

test("a restart over in-flight runs asks first, refuses without a TTY, and stays owed", async () => {
  const port = await fakeService({
    runs: [
      { runId: "wrun_01", workflow: "example", status: "suspended" },
      { runId: "wrun_02", workflow: "example", status: "completed" },
    ],
  });
  const root = factory({ port });
  const io = { exec: fakeExec(), procs: fakeProcesses() };
  await up(root, io);
  io.exec.bundle = "bundle v2";

  lines = [];
  const noTty = await up(root, io);
  expect(noTty.ok).toBe(false);
  expect(statuses(noTty).at(-1)).toBe("service:failed");
  expect(noTty.steps.at(-1)?.repair).toContain("--force");
  expect(lines.join("\n")).toContain("wrun_01");
  expect(lines.join("\n")).not.toContain("wrun_02");
  expect(io.procs.spawns).toHaveLength(1);

  // The refused restart rebuilt the bundle on disk; what the service runs is
  // still v1, so the next up must not read the rebuild as "unchanged".
  const declined = await up(root, io, { confirm: async () => false });
  expect(declined.ok).toBe(false);
  expect(declined.steps.at(-1)?.detail).toContain("declined");
  expect(io.procs.spawns).toHaveLength(1);

  const confirm = vi.fn(async (_question: string) => true);
  const agreed = await up(root, io, { confirm });
  expect(agreed.service).toBe("restarted");
  expect(confirm.mock.calls[0]?.[0]).toContain("1 in-flight run(s)");
  expect(io.procs.spawns).toHaveLength(2);

  io.exec.bundle = "bundle v3";
  const forced = await up(root, io, {}, { force: true });
  expect(forced.service).toBe("restarted");
  expect(io.procs.spawns).toHaveLength(3);
});

test("a restart whose service answers nothing is not asked about", async () => {
  const port = await fakeService({
    runs: [{ runId: "wrun_01", workflow: "example", status: "suspended" }],
  });
  const root = factory({ port });
  const io = { exec: fakeExec(), procs: fakeProcesses() };
  await up(root, io);

  // The pid is alive but the port is silent — the boot window. No run list
  // can be had, and nothing is holding a run this restart could cut off.
  closeFakeServices();
  io.exec.bundle = "bundle v2";
  const confirm = vi.fn(async () => true);

  const result = await up(root, io, { confirm, readyTimeoutMs: 30 });

  expect(confirm).not.toHaveBeenCalled();
  expect(io.procs.spawns).toHaveLength(2);
  expect(result.service).toBe("restarted");
});

test("--no-doctor skips the last step and says so", async () => {
  const port = await fakeService();
  const root = factory({ port });
  const io = { exec: fakeExec(), procs: fakeProcesses() };

  const result = await up(root, io, {}, { doctor: false });

  expect(result.ok).toBe(true);
  expect(statuses(result).at(-1)).toBe("doctor:skipped");
  expect(lines).toContain("skip doctor — --no-doctor");
});

test("a red doctor is the final failing line, with its checks indented above", async () => {
  const port = await fakeService({
    doctor: {
      ok: false,
      checks: [
        {
          id: "linear.identity",
          label: "Linear identity",
          ok: false,
          reason: "LINEAR_API_KEY is empty",
          repair: "set it in .env",
        },
      ],
    },
  });
  const root = factory({ port });
  const io = { exec: fakeExec(), procs: fakeProcesses() };

  const result = await up(root, io);

  expect(result.ok).toBe(false);
  expect(statuses(result).at(-1)).toBe("doctor:failed");
  expect(lines).toContain("  FAIL Linear identity: LINEAR_API_KEY is empty");
  expect(lines.at(-2)).toBe("FAIL doctor: doctor found 1 problem(s)");
});

test("a service that exits during boot fails ready and prints its log", async () => {
  const port = await closedPort();
  const root = factory({ port });
  const io = { exec: fakeExec(), procs: fakeProcesses() };
  io.procs.dieOnSpawn = true;

  const result = await up(root, io);

  expect(result.ok).toBe(false);
  expect(statuses(result).at(-1)).toBe("ready:failed");
  expect(result.steps.at(-1)?.detail).toContain("exited during boot");
  expect(lines).toContain("  fatal: repo gone");
});

test("a service that never listens fails ready with the boot hint", async () => {
  const port = await fakeService({ health: 503 });
  const root = factory({ port });
  const io = { exec: fakeExec(), procs: fakeProcesses() };

  const result = await up(root, io, { readyTimeoutMs: 30 });

  expect(result.ok).toBe(false);
  expect(result.steps.at(-1)?.detail).toContain("still booting");
  expect(result.steps.at(-1)?.repair).toContain("jigs service logs");
});

test("without jigs.config.ts, up stops before touching the machine", async () => {
  const root = scaffold(tmp, { port: 1, config: false });
  const io = { exec: fakeExec(), procs: fakeProcesses() };

  const result = await up(root, io);

  expect(result.ok).toBe(false);
  expect(statuses(result)).toEqual(["locate:failed"]);
  expect(result.steps[0]?.repair).toContain("jigs init");
  expect(io.exec.calls).toHaveLength(0);
  expect(existsSync(path.join(root, ".env"))).toBe(false);
});

test("outside a factory repo, locate fails with the existing error", async () => {
  const io = { exec: fakeExec(), procs: fakeProcesses() };
  const result = await up(tmp, io);
  expect(statuses(result)).toEqual(["locate:failed"]);
  expect(result.steps[0]?.detail).toContain("not inside a factory repo");
});

test("no .env and no .env.example points back at jigs init", async () => {
  const root = factory({ port: 1, example: false });
  const io = { exec: fakeExec(), procs: fakeProcesses() };

  const result = await up(root, io);

  expect(statuses(result)).toEqual(["locate:ok", "env:failed"]);
  expect(result.steps[1]?.repair).toContain("jigs init");
  expect(io.exec.calls).toHaveLength(0);
});

test("an existing .env is kept and its credentials are not reported when set", async () => {
  const port = await fakeService();
  const root = factory({
    port,
    env: "WORKFLOW_POSTGRES_URL=postgres://jigs:jigs@localhost:5555/jigs\nLINEAR_API_KEY=lin\nGITHUB_TOKEN=ghp\n",
  });
  const io = { exec: fakeExec(), procs: fakeProcesses() };

  await up(root, io);

  expect(lines.join("\n")).not.toContain("empty in .env");
});

test("a missing .env fails env with the copy as its repair, and copies nothing", async () => {
  const root = scaffold(tmp, { port: 1 });
  const io = { exec: fakeExec(), procs: fakeProcesses() };

  const result = await up(root, io);

  expect(statuses(result)).toEqual(["locate:ok", "env:failed"]);
  expect(result.steps[1]?.detail).toContain("fill in what your workflows need");
  expect(result.steps[1]?.repair).toBe("cp .env.example .env");
  expect(existsSync(path.join(root, ".env"))).toBe(false);
  expect(io.exec.calls).toHaveLength(0);
});

test("docker compose output is streamed under the compose step as it prints", async () => {
  const port = await fakeService();
  const root = factory({ port });
  const exec = fakeExec();
  const execFile = exec.execFile;
  exec.execFile = async (file, args, options) => {
    if (file === "docker") options.onLine?.("Container acme-factory-postgres-1  Healthy");
    return await execFile(file, args, options);
  };

  await up(root, { exec, procs: fakeProcesses() });

  const compose = lines.findIndex((line) => line.startsWith("ok   compose"));
  expect(lines[compose - 1]).toBe("  Container acme-factory-postgres-1  Healthy");
});

test("pnpm missing from PATH is named, not echoed", async () => {
  const root = factory({ port: 1 });
  const io = {
    exec: fakeExec((call) => (call.file === "pnpm" ? execError("ENOENT") : undefined)),
    procs: fakeProcesses(),
  };

  const result = await up(root, io);

  expect(statuses(result).at(-1)).toBe("install:failed");
  expect(result.steps.at(-1)?.repair).toContain("install pnpm");
});

test("a failing pnpm install echoes pnpm's output and stops", async () => {
  const root = factory({ port: 1 });
  const io = {
    exec: fakeExec((call) =>
      call.file === "pnpm" ? execError(1, "ERR_PNPM_NO_MATCHING_VERSION\n") : undefined,
    ),
    procs: fakeProcesses(),
  };

  const result = await up(root, io);

  expect(statuses(result).at(-1)).toBe("install:failed");
  expect(lines).toContain("  ERR_PNPM_NO_MATCHING_VERSION");
  expect(io.exec.calls).toHaveLength(1);
});

test("a stopped docker daemon is told to start, not diagnosed from compose output", async () => {
  const root = factory({ port: 1 });
  const io = {
    exec: fakeExec((call) =>
      call.file === "docker"
        ? execError(1, "Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n")
        : undefined,
    ),
    procs: fakeProcesses(),
  };

  const result = await up(root, io);

  expect(statuses(result).at(-1)).toBe("compose:failed");
  expect(result.steps.at(-1)?.detail).toBe("the docker daemon is not running");
  expect(result.steps.at(-1)?.repair).toBe("start docker");
});

test("no docker-compose.yml fails compose before docker runs", async () => {
  const root = factory({ port: 1, compose: false });
  const io = { exec: fakeExec(), procs: fakeProcesses() };

  const result = await up(root, io);

  expect(statuses(result).at(-1)).toBe("compose:failed");
  expect(io.exec.calls.map((call) => call.file)).toEqual(["pnpm"]);
});

test("bootstrap refuses to run without a World URL in .env", async () => {
  const root = factory({ port: 1, env: "LINEAR_API_KEY=lin\n" });
  const io = { exec: fakeExec(), procs: fakeProcesses() };

  const result = await up(root, io);

  expect(statuses(result).at(-1)).toBe("bootstrap:failed");
  expect(result.steps.at(-1)?.detail).toContain("WORKFLOW_POSTGRES_URL");
  expect(io.exec.calls.some((call) => path.basename(call.file) === "bootstrap")).toBe(false);
});

test("a missing bootstrap bin names the package pnpm install did not bring", async () => {
  const root = factory({ port: 1, bins: ["nitro"] });
  const io = { exec: fakeExec(), procs: fakeProcesses() };

  const result = await up(root, io);

  expect(statuses(result).at(-1)).toBe("bootstrap:failed");
  expect(result.steps.at(-1)?.repair).toContain("@workflow/world-postgres");
});

test("a World bootstrap cannot reach names both sides of the port mismatch", async () => {
  const root = factory({ port: 1 });
  const io = {
    exec: fakeExec((call) =>
      path.basename(call.file) === "bootstrap"
        ? execError(1, "Error: connect ECONNREFUSED 127.0.0.1:5555\n")
        : undefined,
    ),
    procs: fakeProcesses(),
  };

  const result = await up(root, io);

  expect(statuses(result).at(-1)).toBe("bootstrap:failed");
  expect(result.steps.at(-1)?.detail).toContain("postgres://jigs:***@localhost:5555/jigs");
  expect(result.steps.at(-1)?.repair).toContain(":5555");
});

test("a failing build is nitro's failure, echoed, and nothing starts", async () => {
  const root = factory({ port: 1 });
  const io = {
    exec: fakeExec((call) =>
      path.basename(call.file) === "nitro"
        ? execError(1, "ERROR could not resolve ./jigs.config\n")
        : undefined,
    ),
    procs: fakeProcesses(),
  };

  const result = await up(root, io);

  expect(statuses(result).at(-1)).toBe("build:failed");
  expect(lines).toContain("  ERROR could not resolve ./jigs.config");
  expect(io.procs.spawns).toHaveLength(0);
});

test("a jigs migration failure stops bootstrap before the build or service start", async () => {
  const port = await fakeService();
  const root = factory({ port });
  const io = { exec: fakeExec(), procs: fakeProcesses() };
  const result = await up(root, io, {
    migrate: async () => {
      throw new Error("migration failed");
    },
  });
  expect(result.ok).toBe(false);
  expect(statuses(result).at(-1)).toBe("bootstrap:failed");
  expect(result.steps.some((step) => step.name === "build")).toBe(false);
  expect(lines.join("\n")).toContain("migration failed");
});
