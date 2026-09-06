import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { type BuildDeps, buildFactoryService } from "./build.ts";

// A factory with no reachable service: the run-in-flight warning is a best
// effort, so every test here exercises the build path itself.
function factory(port = 59321): string {
  const root = mkdtempSync(path.join(tmpdir(), "jigs-build-"));
  writeFileSync(
    path.join(root, "jigs.yml"),
    `service:\n  port: ${port}\n  dashboard_port: 9090\n`,
  );
  mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
  writeFileSync(path.join(root, "node_modules", ".bin", "nitro"), "");
  return root;
}

type ExecFile = NonNullable<BuildDeps["execFile"]>;

const ok: ExecFile = async () => ({ stdout: "", stderr: "" });

test("prepares the factory, then runs the factory's own nitro", async () => {
  const root = factory();
  const prepare = vi.fn();
  const execFile = vi.fn<ExecFile>(async () => ({
    stdout: "Σ Nitro server built\n",
    stderr: "",
  }));
  const lines: string[] = [];

  await buildFactoryService({
    cwd: root,
    out: (line) => lines.push(line),
    prepare,
    execFile,
  });

  expect(prepare).toHaveBeenCalledWith(root);
  expect(execFile).toHaveBeenCalledWith(
    path.join(root, "node_modules", ".bin", "nitro"),
    ["build"],
    { cwd: root },
  );
  expect(lines).toContain("Σ Nitro server built");
  expect(lines.at(-1)).toBe(
    `built ${path.join(root, ".output/server/index.mjs")}`,
  );
});

test("a factory with no nitro installed is told to install, not to guess", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "jigs-build-"));
  writeFileSync(path.join(root, "jigs.yml"), "service:\n  port: 59321\n");

  await expect(
    buildFactoryService({
      cwd: root,
      out: () => {},
      prepare: vi.fn(),
      execFile: ok,
    }),
  ).rejects.toThrow(/no nitro in/);
});

test("a failing nitro prints its output and fails the verb", async () => {
  const root = factory();
  const lines: string[] = [];
  const execFile: ExecFile = () =>
    Promise.reject(
      Object.assign(new Error("exit 1"), {
        stdout: "",
        stderr: "ERROR could not resolve ./jigs.config\n",
      }),
    );

  await expect(
    buildFactoryService({
      cwd: root,
      out: (line) => lines.push(line),
      prepare: vi.fn(),
      execFile,
    }),
  ).rejects.toThrow(/nitro build failed/);
  expect(lines).toContain("ERROR could not resolve ./jigs.config");
});

test("outside a factory repo, the verb refuses before touching anything", async () => {
  const outside = mkdtempSync(path.join(tmpdir(), "jigs-nowhere-"));
  const prepare = vi.fn();

  await expect(
    buildFactoryService({ cwd: outside, out: () => {}, prepare, execFile: ok }),
  ).rejects.toThrow(/not inside a factory repo/);
  expect(prepare).not.toHaveBeenCalled();
});

test("a run still in flight is a warning, not a refusal", async () => {
  const runs = {
    runs: [
      {
        runId: "wrun_01",
        pipeline: "example",
        status: "suspended",
        trigger: "manual",
        createdAt: new Date().toISOString(),
      },
      {
        runId: "wrun_02",
        pipeline: "example",
        status: "completed",
        trigger: "manual",
        createdAt: new Date().toISOString(),
      },
    ],
    worktrees: [],
    schedules: [],
  };
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(runs));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const root = factory(port);
  const lines: string[] = [];
  try {
    await buildFactoryService({
      cwd: root,
      out: (line) => lines.push(line),
      prepare: vi.fn(),
      execFile: ok,
    });
  } finally {
    server.close();
  }

  const printed = lines.join("\n");
  expect(printed).toContain("1 run(s) still in flight");
  expect(printed).toContain("wrun_01");
  expect(printed).not.toContain("wrun_02");
  // Warned, then built anyway — the human decides.
  expect(lines.at(-1)).toBe(
    `built ${path.join(root, ".output/server/index.mjs")}`,
  );
});
