import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { ExecFile, ExecOptions } from "../exec.ts";
import { SERVICE_ENTRY, type ServiceProcesses, type SpawnSpec } from "./service-lifecycle.ts";

// The machine as `up` and `upgrade` see it: a scaffolded factory on disk, the
// child processes they exec, the service process they supervise, and the HTTP
// service they poll. Every piece is a fake a test controls.

const servers: Server[] = [];

export function closeFakeServices(): void {
  for (const server of servers.splice(0)) server.close();
}

// A factory the way `jigs init` leaves it, plus the code the operator wrote.
export interface FactoryShape {
  port: number;
  example?: boolean;
  env?: string;
  compose?: boolean;
  config?: boolean;
  linearIdentity?: "key" | "app";
  bins?: string[];
}

export function factory(tmp: string, shape: FactoryShape): string {
  const root = path.join(tmp, "acme-factory");
  mkdirSync(root, { recursive: true });
  if (shape.example !== false) {
    writeFileSync(
      path.join(root, ".env.example"),
      "WORKFLOW_TARGET_WORLD=@workflow/world-postgres\nWORKFLOW_POSTGRES_URL=postgres://jigs:jigs@localhost:5555/jigs\nLINEAR_API_KEY=\nLINEAR_CLIENT_ID=\nLINEAR_CLIENT_SECRET=\nGITHUB_TOKEN=\n",
    );
  }
  if (shape.env !== undefined) writeFileSync(path.join(root, ".env"), shape.env);
  if (shape.compose !== false) {
    writeFileSync(
      path.join(root, "docker-compose.yml"),
      'name: acme-factory\nservices:\n  postgres:\n    ports:\n      - "5555:5432"\n',
    );
  }
  if (shape.config !== false) {
    writeFileSync(
      path.join(root, "jigs.config.ts"),
      `export default {service: {port: ${shape.port}, dashboardPort: 9200}, linear: {identity: {mode: "${shape.linearIdentity ?? "key"}"}}, workflows: {}};\n`,
    );
  }
  const bin = path.join(root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  for (const name of shape.bins ?? ["nitro", "bootstrap"]) {
    writeFileSync(path.join(bin, name), "");
  }
  return root;
}

export interface Call {
  file: string;
  args: string[];
  options: ExecOptions;
}

// Stands in for pnpm, docker, bootstrap and nitro. The fake nitro writes the
// bundle, so a test controls whether a build changes it; the fake docker
// names the Postgres container and volume the way compose would.
export function fakeExec(fail?: (call: Call) => Error | undefined) {
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
    if (file === "docker" && args[1] === "ps") {
      return {
        stdout: `${JSON.stringify({ Name: "acme-factory-postgres-1", Service: "postgres" })}\n`,
        stderr: "",
      };
    }
    if (file === "docker" && args[1] === "config") {
      return {
        stdout: JSON.stringify({
          volumes: { "postgres-data": { name: "acme-factory_postgres-data" } },
        }),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  };
  return state;
}

export const execError = (code: number | string, stderr = "") =>
  Object.assign(new Error(`exit ${code}`), { code, stdout: "", stderr });

export interface FakeProcesses {
  processes: ServiceProcesses;
  spawns: SpawnSpec[];
  signals: Array<{ pid: number; sig: NodeJS.Signals | 0 }>;
  alive: Set<number>;
  dieOnSpawn: boolean;
}

export function fakeProcesses(): FakeProcesses {
  let nextPid = 4242;
  const state: FakeProcesses = {
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

export interface ServiceRoutes {
  health?: number;
  runs?: Array<{ runId: string; workflow: string; status: string }>;
  doctor?: { ok: boolean; checks: unknown[] };
}

// The running service, as far as `up` can tell: /health, /api/runs and
// /api/doctor answer whatever the test declares.
export async function fakeService(routes: ServiceRoutes = {}): Promise<number> {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") {
      res.statusCode = routes.health ?? 200;
      res.end(JSON.stringify({ ok: true }));
    } else if (req.url === "/api/runs") {
      const at = new Date().toISOString();
      res.end(
        JSON.stringify({
          runs: (routes.runs ?? []).map((run) => ({
            trigger: "manual",
            ticket: null,
            createdAt: at,
            lastActivityAt: at,
            steps: 0,
            lastStep: null,
            suspended: false,
            suspensions: [],
            ...run,
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

export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
