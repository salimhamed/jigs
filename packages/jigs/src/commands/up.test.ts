import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ExecFile, ExecOptions } from "../exec.ts";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import type { ServiceProcesses, SpawnSpec } from "./service-lifecycle.ts";
import { SERVICE_ENTRY } from "./service-lifecycle.ts";
import { type UpDeps, type UpOptions, upFactory } from "./up.ts";

let tmp: string;
let lines: string[];
const servers: Server[] = [];

beforeEach(() => {
  tmp = makeTmpDir();
  lines = [];
  vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) server.close();
  removeTmpDir(tmp);
});

// A factory the way `jigs init` leaves it, plus the code the operator wrote.
interface FactoryShape {
  port: number;
  example?: boolean;
  env?: string;
  compose?: boolean;
  config?: boolean;
  bins?: string[];
}

function factory(shape: FactoryShape): string {
  const root = path.join(tmp, "acme-factory");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, "jigs.yml"),
    `service:\n  port: ${shape.port}\n  dashboard_port: 9200\n`,
  );
  if (shape.example !== false) {
    writeFileSync(
      path.join(root, ".env.example"),
      "WORKFLOW_TARGET_WORLD=@workflow/world-postgres\nWORKFLOW_POSTGRES_URL=postgres://jigs:jigs@localhost:5555/jigs\nLINEAR_API_KEY=\nGITHUB_TOKEN=\n",
    );
  }
  if (shape.env !== undefined)
    writeFileSync(path.join(root, ".env"), shape.env);
  if (shape.compose !== false) {
    writeFileSync(
      path.join(root, "docker-compose.yml"),
      'services:\n  postgres:\n    ports:\n      - "5555:5432"\n',
    );
  }
  if (shape.config !== false) {
    writeFileSync(path.join(root, "jigs.config.ts"), "export default {};\n");
  }
  const bin = path.join(root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  for (const name of shape.bins ?? ["nitro", "bootstrap"]) {
    writeFileSync(path.join(bin, name), "");
  }
  return root;
}

interface Call {
  file: string;
  args: string[];
  options: ExecOptions;
}

// Stands in for pnpm, docker, bootstrap and nitro. The fake nitro writes the
// bundle, so a test controls whether a build changes it.
function fakeExec(fail?: (call: Call) => Error | undefined) {
  const state = {
    calls: [] as Call[],
    bundle: "bundle v1",
    execFile: undefined as unknown as ExecFile,
  };
  state.execFile = async (file, args, options) => {
    const call = { file, args, options };
    state.calls.push(call);
    const err = fail?.(call);
    if (err !== undefined) throw err;
    if (path.basename(file) === "nitro") {
      const entry = path.join(options.cwd, SERVICE_ENTRY);
      mkdirSync(path.dirname(entry), { recursive: true });
      writeFileSync(entry, state.bundle);
    }
    return { stdout: "", stderr: "" };
  };
  return state;
}

const execError = (code: number | string, stderr = "") =>
  Object.assign(new Error(`exit ${code}`), { code, stdout: "", stderr });

interface Fake {
  processes: ServiceProcesses;
  spawns: SpawnSpec[];
  signals: Array<{ pid: number; sig: NodeJS.Signals | 0 }>;
  alive: Set<number>;
  dieOnSpawn: boolean;
}

function fakeProcesses(): Fake {
  let nextPid = 4242;
  const state: Fake = {
    spawns: [],
    signals: [],
    alive: new Set(),
    dieOnSpawn: false,
    processes: undefined as unknown as ServiceProcesses,
  };
  state.processes = {
    spawn(spec) {
      state.spawns.push(spec);
      const pid = nextPid++;
      if (state.dieOnSpawn) {
        mkdirSync(path.dirname(spec.logPath), { recursive: true });
        writeFileSync(spec.logPath, "cloning binding api\nfatal: repo gone\n");
      } else {
        state.alive.add(pid);
      }
      return pid;
    },
    signal(pid, sig) {
      state.signals.push({ pid, sig });
      if (sig === "SIGTERM") state.alive.delete(pid);
      return state.alive.has(pid);
    },
  };
  return state;
}

interface ServiceRoutes {
  health?: number;
  runs?: Array<{ runId: string; pipeline: string; status: string }>;
  doctor?: { ok: boolean; checks: unknown[] };
}

// The running service, as far as `up` can tell: /health, /api/runs and
// /api/doctor answer whatever the test declares.
async function fakeService(routes: ServiceRoutes = {}): Promise<number> {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") {
      res.statusCode = routes.health ?? 200;
      res.end(JSON.stringify({ ok: true }));
    } else if (req.url === "/api/runs") {
      res.end(
        JSON.stringify({
          runs: (routes.runs ?? []).map((run) => ({
            ...run,
            trigger: "manual",
            createdAt: new Date().toISOString(),
          })),
          worktrees: [],
          schedules: [],
        }),
      );
    } else if (req.url === "/api/doctor") {
      res.end(
        JSON.stringify(
          routes.doctor ?? {
            ok: true,
            checks: [{ id: "core.claude", label: "claude", ok: true }],
          },
        ),
      );
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function up(
  root: string,
  io: { exec: ReturnType<typeof fakeExec>; procs: Fake },
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

  expect(
    io.exec.calls.map((call) => [path.basename(call.file), ...call.args]),
  ).toEqual([
    ["pnpm", "install"],
    ["docker", "compose", "up", "-d", "--wait"],
    ["bootstrap"],
    ["nitro", "build"],
  ]);
  for (const call of io.exec.calls) expect(call.options.cwd).toBe(root);
  expect(io.procs.spawns).toHaveLength(1);

  // .env was copied, and the slots that stay empty are named, not refused.
  expect(readFileSync(path.join(root, ".env"), "utf8")).toContain(
    "WORKFLOW_POSTGRES_URL=",
  );
  const printed = lines.join("\n");
  expect(printed).toMatch(
    /^ok {3}env \(\d+ms\) — copied \.env\.example to \.env$/m,
  );
  expect(printed).toContain("LINEAR_API_KEY, GITHUB_TOKEN empty in .env");
  expect(printed).toMatch(/^ok {3}doctor \(\d+ms\)$/m);
  expect(lines.at(-1)).toContain(`is up at http://localhost:${port}`);
});

test("bootstrap is handed the World URL from .env explicitly", async () => {
  const port = await fakeService();
  const root = factory({ port });
  const io = { exec: fakeExec(), procs: fakeProcesses() };

  await up(root, io);

  const bootstrap = io.exec.calls.find(
    (call) => path.basename(call.file) === "bootstrap",
  );
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
  expect(lines.join("\n")).toMatch(
    /^ok {3}service .* — unchanged, not restarted$/m,
  );
});

test("a changed bundle restarts the service; --restart forces one", async () => {
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
      { runId: "wrun_01", pipeline: "example", status: "suspended" },
      { runId: "wrun_02", pipeline: "example", status: "completed" },
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
          id: "core.linear-api-key",
          label: "Linear API key",
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
  expect(lines).toContain("  FAIL Linear API key: LINEAR_API_KEY is empty");
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
  const root = factory({ port: 1, config: false });
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
  expect(lines.join("\n")).not.toContain("copied .env.example");
});

test("pnpm missing from PATH is named, not echoed", async () => {
  const root = factory({ port: 1 });
  const io = {
    exec: fakeExec((call) =>
      call.file === "pnpm" ? execError("ENOENT") : undefined,
    ),
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
      call.file === "pnpm"
        ? execError(1, "ERR_PNPM_NO_MATCHING_VERSION\n")
        : undefined,
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
        ? execError(
            1,
            "Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n",
          )
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
  expect(
    io.exec.calls.some((call) => path.basename(call.file) === "bootstrap"),
  ).toBe(false);
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
  expect(result.steps.at(-1)?.detail).toContain(
    "postgres://jigs:***@localhost:5555/jigs",
  );
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
