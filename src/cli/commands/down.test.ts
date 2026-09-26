import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resolveService } from "../../config/factory-config.ts";
import { makeTmpDir, removeTmpDir } from "../../test-fixtures.ts";
import { downFactory } from "./down.ts";
import { servicePidfilePath, serviceSupervisionPath } from "./service-lifecycle.ts";
import {
  execError,
  type FakeProcesses,
  fakeExec,
  fakeProcesses,
  factory as scaffold,
} from "./test-fixtures.ts";

let tmp: string;
let lines: string[];

beforeEach(() => {
  tmp = makeTmpDir();
  lines = [];
  vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

function down(root: string, io: { exec: ReturnType<typeof fakeExec>; procs: FakeProcesses }) {
  return downFactory({
    cwd: root,
    out: (line) => lines.push(line),
    execFile: io.exec.execFile,
    processes: io.procs.processes,
  });
}

function running(root: string, procs: FakeProcesses, pid: number): string {
  const { slug } = resolveService(root);
  const pidfile = servicePidfilePath(slug);
  mkdirSync(path.dirname(pidfile), { recursive: true });
  writeFileSync(pidfile, `${pid}\n`);
  writeFileSync(serviceSupervisionPath(slug), `${JSON.stringify({ processGroup: pid })}\n`);
  procs.alive.add(pid);
  return slug;
}

test("stops the service process, then Postgres without removing its volume", async () => {
  const root = scaffold(tmp, { port: 1 });
  const io = { exec: fakeExec(), procs: fakeProcesses() };
  const slug = running(root, io.procs, 53812);

  await down(root, io);

  expect(io.procs.signals).toContainEqual({ pid: 53812, sig: "SIGTERM" });
  expect(existsSync(servicePidfilePath(slug))).toBe(false);
  expect(io.exec.calls.map((call) => [call.file, ...call.args])).toEqual([
    ["docker", "compose", "ps", "-a", "--format", "json"],
    ["docker", "compose", "config", "--format", "json"],
    ["docker", "compose", "down"],
  ]);
  for (const call of io.exec.calls) expect(call.options.cwd).toBe(root);
  expect(lines).toEqual([
    `stopped service ${slug} (pid 53812)`,
    "stopped postgres container acme-factory-postgres-1  (data kept in volume acme-factory_postgres-data)",
    "",
    "acme-factory is down — start again with pnpm exec jigs up",
  ]);
});

test("a service that is not running is said so, and Postgres still stops", async () => {
  const root = scaffold(tmp, { port: 1 });
  const io = { exec: fakeExec(), procs: fakeProcesses() };

  await down(root, io);

  const { slug } = resolveService(root);
  expect(lines[0]).toBe(`service ${slug} was not running`);
  expect(io.exec.calls.map((call) => call.args).at(-1)).toEqual(["compose", "down"]);
  expect(lines.at(-1)).toBe("acme-factory is down — start again with pnpm exec jigs up");
});

test("names compose cannot give are left out, not guessed", async () => {
  const root = scaffold(tmp, { port: 1 });
  const io = {
    exec: fakeExec((call) => (call.args[1] === "down" ? undefined : execError(1))),
    procs: fakeProcesses(),
  };

  await down(root, io);

  expect(lines).toContain("stopped postgres container");
});

test("docker compose output is streamed as it prints", async () => {
  const root = scaffold(tmp, { port: 1 });
  const exec = fakeExec();
  const execFile = exec.execFile;
  exec.execFile = async (file, args, options) => {
    options.onLine?.("Container acme-factory-postgres-1  Removed");
    return await execFile(file, args, options);
  };

  await down(root, { exec, procs: fakeProcesses() });

  expect(lines).toContain("  Container acme-factory-postgres-1  Removed");
});

test("a stopped docker daemon is told to start", async () => {
  const root = scaffold(tmp, { port: 1 });
  const io = {
    exec: fakeExec(() =>
      execError(1, "Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n"),
    ),
    procs: fakeProcesses(),
  };

  await expect(down(root, io)).rejects.toMatchObject({
    message: "the docker daemon is not running",
    hint: "start docker",
  });
  expect(lines.some((line) => line.includes("is down"))).toBe(false);
});

test("docker missing from PATH is named", async () => {
  const root = scaffold(tmp, { port: 1 });
  const io = { exec: fakeExec(() => execError("ENOENT")), procs: fakeProcesses() };

  await expect(down(root, io)).rejects.toMatchObject({ message: "docker is not on PATH" });
});
