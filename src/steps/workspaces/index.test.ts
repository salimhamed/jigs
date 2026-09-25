import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { provisionWorktree } from "./index.ts";
import { bindingDir, worktreePath } from "./layout.ts";
import type { OwnerState } from "./owner.ts";
import { PostCreateFailedError } from "./provision.ts";
import type { RegistrySql, WorktreeRow } from "./registry.ts";
import { WorktreeOwnedError } from "./reuse.ts";
import { git, makeClonedBinding, makeFakeSql, makeTmpDir, removeTmpDir } from "./test-fixtures.ts";

// A real factory repo, a real clone of a real origin, and real cuts on disk:
// the registry is the only stand-in, so what these tests are about is the
// three-way resolution around it — who owns the tree, what is on disk, and
// what the row ends up saying.

let tmp: string;
let factoryRoot: string;
let repoDir: string;
let remoteDir: string;
let target: string;
let store: Map<string, WorktreeRow>;
let log: string[];

const request = { binding: "api", branch: "feat" };

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
  ({ repoDir, remoteDir } = makeClonedBinding(tmp, bindingDir(dirs)));
  target = worktreePath({ ...dirs, branch: request.branch });
  writeBinding();
  store = new Map();
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

const immediateLock = async <T>(_runId: string, action: (sql: RegistrySql) => Promise<T>) =>
  action(makeFakeSql(store));
const registry = () => ({ sql: makeFakeSql(store), withLock: immediateLock });

// The owner read is the World, the one external system this path consults.
const ownedBy = (runId: string, owner: OwnerState = { terminal: true, status: "completed" }) => ({
  sql: makeFakeSql(store),
  withLock: immediateLock,
  readOwner: async (asked: string) => {
    expect(asked).toBe(runId);
    return owner;
  },
});

// The tree a previous run left behind, cut the way the request path cuts it.
const existingWorktree = (ownerRunId: string) =>
  provisionWorktree(request, { workflowRunId: ownerRunId }, registry());

const originMain = () => git(repoDir, "rev-parse", "refs/remotes/origin/main");

test("a worktree registered to a live run is refused, naming the owner", async () => {
  await existingWorktree("run_owner");
  const failure = await provisionWorktree(
    request,
    { workflowRunId: "run_new" },
    ownedBy("run_owner", { terminal: false, status: "running" }),
  ).then(
    () => null,
    (err: unknown) => err,
  );
  expect(failure).toBeInstanceOf(WorktreeOwnedError);
  expect((failure as WorktreeOwnedError).owningRunId).toBe("run_owner");
  // The escape hatch the message names has to keep existing.
  expect((failure as WorktreeOwnedError).message).toContain("jigs cancel run_owner");
  expect(store.get(target)?.ownerRunId).toBe("run_owner");
});

test("a live foreign owner is refused before disk is ever inspected", async () => {
  await existingWorktree("run_owner");
  // Inspecting the tree fetches, so with origin gone that read would throw:
  // the refusal proves the owner was answered for first.
  git(repoDir, "remote", "set-url", "origin", path.join(tmp, "nonexistent"));

  await expect(
    provisionWorktree(
      request,
      { workflowRunId: "run_new" },
      ownedBy("run_owner", { terminal: false, status: "running" }),
    ),
  ).rejects.toThrow(WorktreeOwnedError);
});

test("a terminal owner's clean worktree is reused and re-owned", async () => {
  await existingWorktree("run_done");
  // Committed, so the tree stays clean while its HEAD moves off the default
  // branch — which is the only place a re-cut could land it.
  writeFileSync(path.join(target, "shipped.txt"), "shipped\n");
  git(target, "add", "shipped.txt");
  git(target, "commit", "-q", "-m", "shipped");
  const head = git(target, "rev-parse", "HEAD");
  expect(head).not.toBe(originMain());

  const facts = await provisionWorktree(request, { workflowRunId: "run_new" }, ownedBy("run_done"));

  expect(facts).toMatchObject({ binding: request.binding, path: target, baseSha: originMain() });
  // Reused, not re-cut: the work the previous run left is still checked out.
  expect(git(target, "rev-parse", "HEAD")).toBe(head);
  expect(store.get(target)).toMatchObject({
    ownerRunId: "run_new",
    state: "active",
  });
});

test("a registry row whose directory is gone is cut afresh and re-owned", async () => {
  store.set(target, {
    path: target,
    branch: request.branch,
    ownerRunId: "run_done",
    state: "active",
    repoDir,
  });

  const facts = await provisionWorktree(request, { workflowRunId: "run_new" }, ownedBy("run_done"));

  expect(facts).toEqual({
    binding: request.binding,
    path: target,
    branch: request.branch,
    defaultBranch: "main",
    baseSha: originMain(),
  });
  expect(store.get(target)).toMatchObject({
    ownerRunId: "run_new",
    state: "active",
  });
});

test("the owning run re-enters its own dirty worktree without asking whether it is live", async () => {
  await existingWorktree("run_owner");
  writeFileSync(path.join(target, "wip.txt"), "half-finished\n");

  const facts = await provisionWorktree(
    request,
    { workflowRunId: "run_owner" },
    {
      sql: makeFakeSql(store),
      withLock: immediateLock,
      readOwner: () => {
        throw new Error("the owner's own liveness is beside the point");
      },
    },
  );

  expect(facts.baseSha).toBe(originMain());
  expect(readFileSync(path.join(target, "wip.txt"), "utf8")).toBe("half-finished\n");
  expect(store.get(target)?.ownerRunId).toBe("run_owner");
});

test("no worktree on disk cuts one from the default branch and registers the run", async () => {
  const facts = await provisionWorktree(request, { workflowRunId: "run_new" }, registry());

  expect(facts).toEqual({
    binding: request.binding,
    path: target,
    branch: request.branch,
    defaultBranch: "main",
    baseSha: originMain(),
  });
  expect(git(target, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat");
  expect(git(target, "rev-parse", "HEAD")).toBe(originMain());
  expect(store.get(target)).toMatchObject({
    ownerRunId: "run_new",
    state: "active",
    repoDir,
  });
});

test("the binding's own provisioning is what the worktree is provisioned with", async () => {
  const bindingFiles = path.join(factoryRoot, "bindings", "api");
  mkdirSync(bindingFiles, { recursive: true });
  writeFileSync(path.join(bindingFiles, ".env"), "TOKEN=secret\n");
  writeBinding({ copy: [".env"], postCreate: ["echo ran > provisioned"] });

  await provisionWorktree(request, { workflowRunId: "run_a" }, registry());

  expect(readFileSync(path.join(target, ".env"), "utf8")).toBe("TOKEN=secret\n");
  expect(existsSync(path.join(target, "provisioned"))).toBe(true);
});

test("a failing postCreate leaves the row marked provision-failed and rethrows", async () => {
  writeBinding({ postCreate: ["exit 3"] });

  const failure = await provisionWorktree(request, { workflowRunId: "run_a" }, registry()).then(
    () => null,
    (err: unknown) => err,
  );

  expect(failure).toBeInstanceOf(PostCreateFailedError);
  expect(store.get(target)?.state).toBe("provision-failed");
});

test("a binding with no clone is refused, naming the restart that makes one", async () => {
  rmSync(repoDir, { recursive: true, force: true });
  const failure = await provisionWorktree(request, { workflowRunId: "run_a" }, registry()).then(
    () => null,
    (err: unknown) => err,
  );
  expect(String(failure)).toContain(`binding api has no clone at ${repoDir}`);
  expect((failure as { hint?: string }).hint).toContain("jigs service restart");
  expect(store.size).toBe(0);
});

test("a provisioned worktree logs its binding, branch, and path", async () => {
  await provisionWorktree(request, { workflowRunId: "run_a" }, registry());
  expect(log).toContain(`[worktree] provisioned binding=api branch=feat path=${target}`);
});
