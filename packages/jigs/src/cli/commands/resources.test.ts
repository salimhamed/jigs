import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { factorySlug } from "../../config/paths.ts";
import type { RegistrySql, ResourceRow } from "../../steps/runtime/registry.ts";
import { readRunState } from "../../steps/runtime/run-state.ts";
import { memoryLock, memoryRows } from "../../steps/runtime/test-fixtures.ts";
import { commitToRemote, git, makeClonedBinding } from "../../steps/workspaces/test-fixtures.ts";
import { runFrom } from "../../test-fixtures.ts";
import { layoutProblems } from "../output-layout.ts";
import { listResources, offlineFacts, runResourcesPrune } from "./resources.ts";
import type { ServiceProcesses } from "./service-process.ts";
import { readServiceRecord } from "./service-record.ts";
import {
  FAKE_BOOT,
  FAKE_START,
  recordService as recordFactoryService,
  SERVICE_COMMAND,
} from "./test-fixtures.ts";

vi.mock("../../steps/runtime/registry.ts", async (original) => ({
  ...(await original<typeof import("../../steps/runtime/registry.ts")>()),
  ...(await import("../../steps/runtime/test-fixtures.ts")).memoryRegistry(),
}));

const RUN = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";
const LIVE = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7LIV";
let tmp: string;
let root: string;
let lines: string[];

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "jigs-resource-command-"));
  root = path.join(tmp, "factory");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, "jigs.config.ts"),
    "export default { hub: { url: 'https://hub.example.test' }, workflows: {} };\n",
  );
  vi.stubEnv("WORKFLOW_POSTGRES_URL", "postgres://unused/test");
  runFrom(root);
  vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
  memoryRows.length = 0;
  memoryLock.taken = undefined;
  lines = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

// Only the World's run status is read offline; the registry is the memory one.
function database(statuses: Record<string, string> = { [RUN]: "completed" }): RegistrySql {
  return {
    $client: {
      async query(_text: string, [runId]: string[]) {
        const status = statuses[runId as string];
        return { rows: status === undefined ? [] : [{ status, name: "workflow//./ship//ship" }] };
      },
      async end() {},
    },
  } as unknown as RegistrySql;
}

function seed(kind: string, over: Partial<ResourceRow> = {}): ResourceRow {
  const row: ResourceRow = {
    factory: factorySlug(root),
    runId: RUN,
    kind,
    identity: over.runId ?? RUN,
    url: "file:///scratch",
    state: "live",
    reason: null,
    attempts: 0,
    repoDir: null,
    branch: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
  memoryRows.push(row);
  return row;
}

function scratch(runId = RUN): string {
  const directory = path.join(tmp, "data", "jigs", "scratch", runId);
  mkdirSync(directory, { recursive: true });
  return directory;
}

const deps = (statuses?: Record<string, string>) => ({
  out: (line: string) => lines.push(line),
  connect: () => database(statuses),
});

test("list shows this factory's unreleased records with what prune would do", async () => {
  seed("run-directory");
  seed("pull-request", { identity: "acme/api#1" });
  seed("codex-home", { state: "kept", reason: "onFailure policy keeps run resources" });
  seed("pi-home", { state: "released", reason: "removed" });
  seed("run-directory", { runId: LIVE });
  seed("run-directory", { factory: "another-factory" });

  const report = await listResources(deps({ [RUN]: "completed", [LIVE]: "running" }), {
    json: true,
  });

  expect(report.complete).toBe(true);
  expect(
    report.entries.map((entry) => [
      entry.runId,
      entry.kind,
      entry.state,
      entry.eligible,
      entry.decision,
    ]),
  ).toEqual([
    [RUN, "run-directory", "live", true, "would be removed"],
    [
      RUN,
      "codex-home",
      "kept",
      true,
      "would be removed (previously kept: onFailure policy keeps run resources)",
    ],
    [LIVE, "run-directory", "live", false, "the run is not finished"],
  ]);
  expect(JSON.parse(lines.join("\n"))).toEqual(report);
});

test("prune overrides the policy: live, kept and failed records of finished runs alike", async () => {
  seed("run-directory");
  seed("codex-home", { state: "kept", reason: "onFailure policy keeps run resources" });
  seed("pi-home", { state: "failed", reason: "release failed: EBUSY", attempts: 2 });

  const report = await listResources(deps(), {});

  expect(report.entries.map((entry) => [entry.kind, entry.eligible])).toEqual([
    ["run-directory", true],
    ["codex-home", true],
    ["pi-home", true],
  ]);
  expect(lines).toEqual([
    `${RUN}  completed`,
    "  KIND           ACTION  PATH",
    "  run-directory  remove  /scratch",
    "  codex-home     remove  /scratch",
    "  pi-home        remove  /scratch",
    "                         previous attempt: release failed: EBUSY",
    "  each one to remove was previously kept: onFailure policy keeps run resources",
    "",
    "3 to remove, 0 to keep (preview only)",
    "to remove them, run:",
    "  pnpm exec jigs resources prune --apply",
  ]);
});

test("kept decisions that differ within a run are named on each resource", async () => {
  seed("worktree", {
    identity: "/w/age-1",
    url: "file:///w/age-1",
    state: "kept",
    reason: "onFailure policy keeps run resources",
    repoDir: "/w",
    branch: "age-1",
  });
  seed("codex-home", {
    state: "kept",
    reason: "release failed: EBUSY (gave up after 5 attempts)",
  });

  await listResources(deps(), {});

  expect(lines).toEqual([
    `${RUN}  completed`,
    "  KIND        ACTION  PATH",
    "  worktree    remove  /w/age-1",
    "                      previously kept: onFailure policy keeps run resources",
    "  codex-home  remove  /scratch",
    "                      previously kept: release failed: EBUSY (gave up after 5 attempts)",
    "",
    "2 to remove, 0 to keep (preview only)",
    "to remove them, run:",
    "  pnpm exec jigs resources prune --apply",
  ]);
});

const pruneAll = (statuses: Record<string, string> = { [RUN]: "cancelled" }) =>
  runResourcesPrune({ ...deps(statuses), processes: machine() }, { apply: true });

test("apply releases finished runs' records and never a running run's", async () => {
  const done = scratch();
  const live = scratch(LIVE);
  seed("run-directory");
  seed("codex-home", { state: "kept", reason: "onFailure policy keeps run resources" });
  seed("run-directory", { runId: LIVE });
  seed("pull-request", { identity: "acme/api#1" });
  const codex = path.join(tmp, "data", "jigs", "codex-homes", RUN);
  mkdirSync(codex, { recursive: true });

  const report = await pruneAll({ [RUN]: "cancelled", [LIVE]: "running" });

  expect(
    report.entries.map((entry) => [entry.runId, entry.kind, entry.state, entry.action]),
  ).toEqual([
    [RUN, "run-directory", "released", "remove"],
    [RUN, "codex-home", "released", "remove"],
    [LIVE, "run-directory", "live", "skip"],
  ]);
  expect(existsSync(done)).toBe(false);
  expect(existsSync(codex)).toBe(false);
  expect(existsSync(live)).toBe(true);
  expect(lines).toEqual([
    `${RUN}  cancelled`,
    "  KIND           RESULT   PATH",
    "  run-directory  removed  /scratch",
    "  codex-home     removed  /scratch",
    "",
    `${LIVE}  running`,
    "  KIND           RESULT   PATH",
    "  run-directory  skipped  /scratch",
    "  the run is not finished, so nothing is removed",
    "",
    "2 removed, 1 kept, 0 failed",
  ]);
  // A recorded-only pull request is history, never visited.
  expect(memoryRows.find((row) => row.kind === "pull-request")?.state).toBe("live");
});

test("a preview never changes anything", async () => {
  const done = scratch();
  seed("run-directory");

  await runResourcesPrune(deps(), {});

  expect(existsSync(done)).toBe(true);
  expect(memoryRows[0]?.state).toBe("live");
  expect(lines.slice(-3)).toEqual([
    "1 to remove, 0 to keep (preview only)",
    "to remove them, run:",
    "  pnpm exec jigs resources prune --apply",
  ]);
});

test("a preview of one run names the command that applies it to that run", async () => {
  scratch();
  seed("run-directory");

  await runResourcesPrune(deps(), { run: RUN });

  expect(lines.at(-1)).toBe(`  pnpm exec jigs resources prune --run ${RUN} --apply`);
});

test("apply never touches another factory's records", async () => {
  const theirs = scratch();
  seed("run-directory", { factory: "another-factory" });

  const report = await pruneAll();

  expect(report.entries).toEqual([]);
  expect(existsSync(theirs)).toBe(true);
  expect(memoryRows[0]?.state).toBe("live");
});

test("a run the World no longer knows counts as finished", async () => {
  const lost = scratch();
  seed("run-directory");

  await pruneAll({});

  expect(existsSync(lost)).toBe(false);
  expect(memoryRows[0]?.state).toBe("released");
});

test("apply decides again under the run's lock: a run that resumed keeps its records", async () => {
  const done = scratch();
  seed("run-directory");
  const statuses: Record<string, string> = { [RUN]: "cancelled" };
  memoryLock.taken = () => {
    statuses[RUN] = "running";
  };

  const report = await runResourcesPrune(
    { ...deps(statuses), processes: machine() },
    { apply: true },
  );

  expect(report.entries[0]).toMatchObject({ action: "skip", decision: "the run is not finished" });
  expect(existsSync(done)).toBe(true);
});

test("a record released between listing and the lock is not visited again", async () => {
  seed("run-directory");
  memoryLock.taken = () => {
    Object.assign(memoryRows[0] as ResourceRow, { state: "released", reason: "removed" });
  };

  expect((await pruneAll()).entries).toEqual([]);
});

function worktree(branch: string, runId = RUN): ResourceRow {
  const parent = path.join(tmp, `clone-${branch}`);
  mkdirSync(parent);
  const { repoDir, worktreesDir } = makeClonedBinding(parent);
  const target = path.join(worktreesDir, branch);
  git(repoDir, "worktree", "add", "-q", target, "-b", branch, "refs/remotes/origin/main");
  return seed("worktree", { runId, identity: target, repoDir, branch });
}

test("a failure is reported and prune carries on with independent resources", async () => {
  const stuck = worktree("stuck");
  git(stuck.repoDir as string, "worktree", "lock", stuck.identity);
  const other = scratch(LIVE);
  seed("run-directory", { runId: LIVE });

  const report = await pruneAll({ [RUN]: "failed", [LIVE]: "failed" });

  expect(report.complete).toBe(false);
  expect(report.errors).toEqual([expect.stringContaining(`${stuck.identity}: release failed:`)]);
  expect(report.entries.map((entry) => [entry.kind, entry.state])).toEqual([
    ["worktree", "failed"],
    ["run-directory", "released"],
  ]);
  expect(existsSync(stuck.identity)).toBe(true);
  expect(existsSync(other)).toBe(false);
});

test("apply keeps a dirty worktree and keeps an unmerged branch's commits", async () => {
  const dirty = worktree("dirty");
  writeFileSync(path.join(dirty.identity, "wip.txt"), "uncommitted\n");
  const unmerged = worktree("unmerged", LIVE);
  writeFileSync(path.join(unmerged.identity, "work.txt"), "work\n");
  git(unmerged.identity, "add", "work.txt");
  git(unmerged.identity, "commit", "-q", "-m", "work");

  await pruneAll({ [RUN]: "failed", [LIVE]: "failed" });

  expect(existsSync(path.join(dirty.identity, "wip.txt"))).toBe(true);
  expect(memoryRows.find((row) => row.branch === "dirty")).toMatchObject({
    state: "kept",
    reason: "uncommitted work kept",
  });
  expect(existsSync(unmerged.identity)).toBe(false);
  expect(git(unmerged.repoDir as string, "branch", "--list", "unmerged")).toContain("unmerged");
});

test("one apply releases a worktree and then the harness homes that waited for it", async () => {
  const tree = worktree("clean");
  seed("pi-home");
  const pi = path.join(tmp, "data", "jigs", "pi-homes", RUN);
  mkdirSync(pi, { recursive: true });

  const preview = await listResources(deps({ [RUN]: "failed" }), {});
  expect(preview.entries.map((entry) => [entry.kind, entry.eligible])).toEqual([
    ["worktree", true],
    ["pi-home", true],
  ]);
  await pruneAll({ [RUN]: "failed" });

  expect(existsSync(tree.identity)).toBe(false);
  expect(existsSync(pi)).toBe(false);
});

test("an apply removes a Claude skills plugin a stopped service left behind", async () => {
  seed("claude-plugins");
  const plugins = path.join(tmp, "data", "jigs", "claude-plugins", RUN);
  mkdirSync(path.join(plugins, "plugin-abc123", "skills"), { recursive: true });

  await pruneAll({ [RUN]: "failed" });

  expect(existsSync(plugins)).toBe(false);
  expect(memoryRows.find((row) => row.kind === "claude-plugins")).toMatchObject({
    state: "released",
  });
});

function leftover() {
  const parent = path.join(tmp, "leftover");
  mkdirSync(parent);
  const { remoteDir, repoDir } = makeClonedBinding(parent);
  commitToRemote(parent, remoteDir, "still-there", { "a.txt": "a" });
  const branch = (name: string, over: Partial<ResourceRow> = {}) =>
    seed("branch", {
      identity: `acme/api:${name}`,
      url: `https://github.com/acme/api/tree/${name}`,
      repoDir,
      branch: name,
      ...over,
    });
  return { repoDir, branch };
}

test("the preview lists branches finished runs left on GitHub, with how to delete them", async () => {
  const { branch } = leftover();
  branch("still-there");
  branch("gone");
  branch("running-run", { runId: LIVE });
  const fetchSpy = vi.spyOn(globalThis, "fetch");

  const report = await listResources(deps({ [RUN]: "completed", [LIVE]: "running" }), {});

  expect(report.leftOnGitHub).toEqual([
    {
      runId: RUN,
      identity: "acme/api:still-there",
      url: "https://github.com/acme/api/tree/still-there",
      checked: true,
      command: "git push origin --delete still-there",
    },
  ]);
  expect(lines).toEqual([
    "Left on GitHub",
    "  acme/api  still-there",
    "  delete it yourself once its PR is merged or closed:",
    "    git push origin --delete still-there",
    "",
    "0 to remove, 0 to keep (preview only)",
  ]);
  // A preview writes nothing, not even for the branch that is gone.
  expect(memoryRows.every((row) => row.state === "live")).toBe(true);
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("the clone's default branch is never listed, whatever the records say", async () => {
  const { branch } = leftover();
  branch("main");

  const report = await pruneAll({ [RUN]: "completed" });

  expect(report.leftOnGitHub).toEqual([]);
  expect(memoryRows[0]?.state).toBe("live");
});

test("apply marks branches deleted outside jigs released and keeps listing the rest", async () => {
  const { branch } = leftover();
  branch("still-there");
  branch("gone");

  const report = await pruneAll({ [RUN]: "completed" });

  expect(report.leftOnGitHub.map((left) => left.identity)).toEqual(["acme/api:still-there"]);
  expect(memoryRows.map((row) => [row.branch, row.state, row.reason])).toEqual([
    ["still-there", "live", null],
    ["gone", "released", "deleted outside jigs"],
  ]);
});

test("a remote that cannot be asked still lists its branches, saying so", async () => {
  seed("branch", {
    identity: "acme/api:unknown",
    url: "https://github.com/acme/api/tree/unknown",
    repoDir: path.join(tmp, "no-such-clone"),
    branch: "unknown",
  });

  const report = await pruneAll({ [RUN]: "completed" });

  expect(report.leftOnGitHub).toMatchObject([{ identity: "acme/api:unknown", checked: false }]);
  expect(memoryRows[0]?.state).toBe("live");
  expect(lines).toContain("  acme/api  unknown (could not check the remote, so it may be gone)");
});

test("the offline read has the run's status and nothing it cannot see", async () => {
  const state = await readRunState(database(), factorySlug(root), RUN, offlineFacts(database()));
  expect(state).toMatchObject({
    status: "completed",
    claim: null,
    suspensions: [],
  });
});

test("--run names a run the World does not know and points at jigs status", async () => {
  await expect(
    listResources(deps(), { run: "wrun_01ZZZZZZZZZZZZZZZZZZZZZZZZ" }),
  ).rejects.toMatchObject({
    message: "run wrun_01ZZZZZZZZZZZZZZZZZZZZZZZZ not found",
    hint: expect.stringContaining("pnpm exec jigs status"),
  });
  expect(lines).toEqual([]);
});

// A machine with the given ps rows; `signal` answers liveness from them.
function machine(rows: string[] = [], boot = FAKE_BOOT): ServiceProcesses {
  const output = rows.map((row) => `${row}\n`).join("");
  const alive = new Set(output.split("\n").map((row) => Number(row.trim().split(/\s+/)[0])));
  return {
    spawn: () => undefined,
    signal: (pid) => alive.has(pid),
    snapshot: () => output,
    bootId: () => boot,
    startTime: (pid) => (alive.has(pid) ? FAKE_START : undefined),
  };
}

const recordService = (pid: number, options: { exited?: true } = {}) =>
  recordFactoryService(factorySlug(root), pid, options);
const recordedProcess = () => readServiceRecord(factorySlug(root)).process;

const prune = (processes: ServiceProcesses, connect: () => RegistrySql) =>
  runResourcesPrune({ out: (line) => lines.push(line), connect, processes }, { apply: true });

test("apply refuses a running service without opening the database", async () => {
  recordService(700);
  const connect = vi.fn(() => database());

  await expect(prune(machine([`700 1 700 Ss ${SERVICE_COMMAND}`]), connect)).rejects.toMatchObject({
    message: "factory service is still running as pid 700",
    hint: expect.stringContaining("pnpm exec jigs service stop"),
  });
  expect(connect).not.toHaveBeenCalled();
});

test("apply refuses while a process is left in the service's recorded group", async () => {
  recordService(700);
  const connect = vi.fn(() => database());

  await expect(
    prune(machine(["1 0 1 Ss init", "812 1 700 S claude --print hello world"]), connect),
  ).rejects.toMatchObject({
    message: expect.stringMatching(
      /still running in the service's recorded process group 700:\n {2}pid 812: claude --print hello world/,
    ),
    hint: expect.stringContaining("pnpm exec jigs service stop"),
  });
  expect(connect).not.toHaveBeenCalled();
});

test("apply proceeds in a factory whose service never ran", async () => {
  const connect = vi.fn(() => database());

  await prune(machine(["1 0 1 Ss init"]), connect);

  expect(connect).toHaveBeenCalled();
});

test("apply proceeds once the service and its group are gone", async () => {
  recordService(700, { exited: true });
  const connect = vi.fn(() => database());

  const report = await prune(machine(["1 0 1 Ss init", "900 1 900 Ss bash"]), connect);

  expect(connect).toHaveBeenCalled();
  expect(report.complete).toBe(true);
});

test("apply proceeds after a restart of the machine, every time, whatever now has the recorded pid", async () => {
  recordService(700);
  const connect = vi.fn(() => database());
  const rebooted = machine(["700 1 700 Ss tmux", "701 700 700 S -zsh"], "boot-2");

  await prune(rebooted, connect);
  expect(recordedProcess()).toBeUndefined();
  await prune(rebooted, connect);

  expect(connect).toHaveBeenCalledTimes(2);
});

test("apply ignores a reused group once a clean stop removed the record", async () => {
  const connect = vi.fn(() => database());

  await prune(machine(["701 1 700 S node /Users/me/other-app/server.js"]), connect);

  expect(connect).toHaveBeenCalled();
});

test("apply removes a crashed service's record once its group is empty", async () => {
  recordService(700);
  const connect = vi.fn(() => database());

  await prune(machine(["1 0 1 Ss init"]), connect);

  expect(connect).toHaveBeenCalled();
  expect(recordedProcess()).toBeUndefined();
});

test("apply proceeds when another program took the pid of a service that exited during boot", async () => {
  recordService(700, { exited: true });
  const connect = vi.fn(() => database());

  await prune(machine(["700 1 700 Ss tmux", "701 700 700 S -zsh"]), connect);

  expect(connect).toHaveBeenCalled();
});

// Every test's output, passing or failing, keeps to the shared layout.
afterEach(() => {
  expect(layoutProblems(lines)).toEqual([]);
});
