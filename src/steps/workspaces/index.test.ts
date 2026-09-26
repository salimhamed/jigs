import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { memoryRows } from "../runtime/test-fixtures.ts";
import { cloneDir, worktreePath } from "./layout.ts";
import { PostCreateFailedError } from "./provision.ts";
import { git, makeClonedBinding, makeTmpDir, removeTmpDir } from "./test-fixtures.ts";

vi.mock("../runtime/registry.ts", async (original) => ({
  ...(await original<typeof import("../runtime/registry.ts")>()),
  ...(await import("../runtime/test-fixtures.ts")).memoryRegistry(),
}));

const { provisionWorktree } = await import("./index.ts");

// A real factory repo, a real clone of a real origin, and real cuts on disk:
// the registry is the only stand-in.

let tmp: string;
let factoryRoot: string;
let repoDir: string;
let remoteDir: string;
let target: string;
let log: string[];

const RUN = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";
const OTHER = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7XYZ";
const request = { binding: "api", branch: "feat" };
const branch = "feat-5c7dkm";
const run = { workflowRunId: RUN };

beforeEach(() => {
  tmp = makeTmpDir();
  factoryRoot = path.join(tmp, "factory");
  mkdirSync(factoryRoot, { recursive: true });
  vi.stubEnv("JIGS_FACTORY_ROOT", factoryRoot);
  vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
  log = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    log.push(line);
  });

  const dirs = { factoryRoot, bindingName: "api" };
  // The clone goes exactly where the layout says the service put it.
  ({ repoDir, remoteDir } = makeClonedBinding(tmp, cloneDir(dirs)));
  target = worktreePath({ ...dirs, branch });
  writeBinding();
  memoryRows.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  removeTmpDir(tmp);
});

function writeBinding(provisioning: Record<string, unknown> = {}): void {
  writeFileSync(
    path.join(factoryRoot, "jigs.config.ts"),
    `export default ${JSON.stringify({ bindings: { api: { remote: remoteDir, ...provisioning } }, service: { port: 8990, dashboardPort: 9090 }, workflows: {} })};`,
  );
}

const records = () =>
  memoryRows
    .filter((row) => row.kind === "worktree")
    .map((row) => ({ runId: row.runId, state: row.state, reason: row.reason }));

const originMain = () => git(repoDir, "rev-parse", "refs/remotes/origin/main");

test("a run cuts its own branch from the default branch and registers it", async () => {
  const facts = await provisionWorktree(request, run);

  expect(facts).toEqual({
    binding: request.binding,
    path: target,
    branch,
    defaultBranch: "main",
    baseSha: originMain(),
  });
  expect(git(target, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
  expect(git(target, "rev-parse", "HEAD")).toBe(originMain());
  expect(memoryRows).toMatchObject([
    {
      factory: "factory-a",
      runId: RUN,
      kind: "worktree",
      identity: target,
      url: pathToFileURL(target).href,
      state: "live",
      repoDir,
      branch,
    },
  ]);
});

test("a retry of the run's own provisioning re-enters its worktree as it is", async () => {
  await provisionWorktree(request, run);
  writeFileSync(path.join(target, "wip.txt"), "half-finished\n");

  const facts = await provisionWorktree(request, run);

  expect(facts.path).toBe(target);
  expect(readFileSync(path.join(target, "wip.txt"), "utf8")).toBe("half-finished\n");
  expect(records()).toEqual([{ runId: RUN, state: "live", reason: null }]);
});

test("another run asking for the same branch gets a branch and worktree of its own", async () => {
  const first = await provisionWorktree(request, run);
  writeFileSync(path.join(first.path, "wip.txt"), "first run's work\n");

  const second = await provisionWorktree(request, { workflowRunId: OTHER });

  expect(second.branch).toBe("feat-5c7xyz");
  expect(second.path).not.toBe(first.path);
  expect(existsSync(path.join(second.path, "wip.txt"))).toBe(false);
  expect(records()).toEqual([
    { runId: RUN, state: "live", reason: null },
    { runId: OTHER, state: "live", reason: null },
  ]);
});

test("the binding's own provisioning is what the worktree is provisioned with", async () => {
  const bindingFiles = path.join(factoryRoot, "bindings", "api");
  mkdirSync(bindingFiles, { recursive: true });
  writeFileSync(path.join(bindingFiles, ".env"), "TOKEN=secret\n");
  writeBinding({ copy: [".env"], postCreate: ["echo ran > provisioned"] });

  await provisionWorktree(request, run);

  expect(readFileSync(path.join(target, ".env"), "utf8")).toBe("TOKEN=secret\n");
  expect(existsSync(path.join(target, "provisioned"))).toBe(true);
});

test("a failing postCreate keeps the record for diagnosis and rethrows", async () => {
  writeBinding({ postCreate: ["exit 3"] });

  const failure = await provisionWorktree(request, run).then(
    () => null,
    (err: unknown) => err,
  );

  expect(failure).toBeInstanceOf(PostCreateFailedError);
  expect(records()).toEqual([
    { runId: RUN, state: "kept", reason: "provisioning failed; kept for diagnosis" },
  ]);
});

test("a binding with no clone is refused, naming the restart that makes one", async () => {
  rmSync(repoDir, { recursive: true, force: true });
  const failure = await provisionWorktree(request, run).then(
    () => null,
    (err: unknown) => err,
  );
  expect(String(failure)).toContain(`binding api has no clone at ${repoDir}`);
  expect((failure as { hint?: string }).hint).toContain("jigs service restart");
  expect(memoryRows).toEqual([]);
});

test("a provisioned worktree logs its binding, branch, and path", async () => {
  await provisionWorktree(request, run);
  expect(log).toContain(`[worktree] provisioned binding=api branch=${branch} path=${target}`);
});
