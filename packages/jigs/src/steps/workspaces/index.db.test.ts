import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, vi } from "vitest";
import { currentFactoryContext } from "../../config/factory-context.ts";
import { databaseUrl, dbTest, postgresAdminUrl } from "../../db-test-fixtures.ts";
import { isForkPullRequest } from "../../providers/github.ts";
import {
  type AutomaticReleaseDeps,
  reconcileAutomaticRelease,
} from "../../service/automatic-release.ts";
import { serveAsGithub } from "../../test-fixtures.ts";
import type { Factory } from "../../workflow/factory.ts";
import {
  ensureRegistry,
  listResources,
  registrySql,
  withRunResourceLock,
} from "../runtime/registry.ts";
import { releaseRun } from "../runtime/release.ts";
import { createRunDirectory } from "../runtime/run-directory/index.ts";
import { readRunState } from "../runtime/run-state.ts";
import { provisionPullRequestWorktree, provisionWorktree } from "./index.ts";
import { cloneDir } from "./layout.ts";
import { git, makeClonedBinding, makeTmpDir, removeTmpDir } from "./test-fixtures.ts";

vi.mock("../../providers/github.ts", () => ({ isForkPullRequest: vi.fn(async () => false) }));
vi.mock("../../providers/github-auth.ts", () => ({
  githubAuthFor: () => ({ bearer: async () => "ghs_test" }),
}));

// Real Postgres, a real clone and real cuts: provisioning, explicit release and
// automatic release all through the one registry and the one release function.
const database = `jigs_workspaces_${crypto.randomUUID().replaceAll("-", "")}`;
const testUrl = databaseUrl(database);
const admin = new Pool({ connectionString: postgresAdminUrl.toString(), max: 1 });

const tmp = makeTmpDir();
const factoryRoot = path.join(tmp, "factory");
mkdirSync(factoryRoot, { recursive: true });
vi.spyOn(process, "cwd").mockReturnValue(factoryRoot);
vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
vi.stubEnv("WORKFLOW_POSTGRES_URL", testUrl.toString());

const dirs = { factoryRoot, bindingName: "api" };
const { remoteDir } = makeClonedBinding(tmp, cloneDir(dirs));
serveAsGithub(remoteDir);
// `web` names the same repository, with no clone yet.
const remote = { remote: "git@github.com:acme/api.git", installationName: "github-acme" };
writeFileSync(
  path.join(factoryRoot, "jigs.config.ts"),
  `export default ${JSON.stringify({ bindings: { api: remote, web: remote }, hub: { url: "https://hub.example.test" }, workflows: {} })};`,
);

const sql = () => registrySql();
const states = async (runId: string) =>
  (await listResources(sql(), { factory: currentFactoryContext().slug, runId })).map((row) => [
    row.kind,
    row.state,
    row.reason,
  ]);

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${database}"`);
  await ensureRegistry(sql());
});
afterAll(async () => {
  await sql().$client.end();
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.end();
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

dbTest("a second run asking for the same branch works on its own branch and worktree", async () => {
  const request = { binding: "api", branch: "same" };
  const first = await provisionWorktree(request, { workflowRunId: "wrun_first1" });
  const second = await provisionWorktree(request, { workflowRunId: "wrun_second" });

  expect(first.branch).toBe("same-first1");
  expect(second.branch).toBe("same-second");
  expect(second.path).not.toBe(first.path);
  expect(await states("wrun_first1")).toEqual([["worktree", "live", null]]);
  expect(await states("wrun_second")).toEqual([["worktree", "live", null]]);
});

dbTest("runs that need a binding's first clone at once share one", async () => {
  const [first, second] = await Promise.all([
    provisionWorktree({ binding: "web", branch: "a" }, { workflowRunId: "wrun_cloneA" }),
    provisionWorktree({ binding: "web", branch: "b" }, { workflowRunId: "wrun_cloneB" }),
  ]);

  expect(first.baseSha).toBe(git(remoteDir, "rev-parse", "refs/heads/main"));
  expect(second.baseSha).toBe(first.baseSha);
});

dbTest("explicit release keeps, then removes, through the real registry", async () => {
  const runId = "run_release";
  const tree = await provisionWorktree(
    { binding: "api", branch: "released" },
    { workflowRunId: runId },
  );
  const directory = await createRunDirectory({ workflowRunId: runId });
  const release = (action: "release" | "keep") =>
    withRunResourceLock(sql(), runId, (locked) =>
      releaseRun(locked, currentFactoryContext().slug, runId, action, "success"),
    );

  await release("keep");
  expect(existsSync(tree.path)).toBe(true);
  expect(await states(runId)).toEqual([
    ["worktree", "kept", "onSuccess policy keeps run resources"],
    ["run-directory", "kept", "onSuccess policy keeps run resources"],
  ]);

  // Kept records are final for release; only prune takes them further.
  await release("release");
  expect(existsSync(tree.path)).toBe(true);
  expect(existsSync(directory)).toBe(true);
});

dbTest("automatic release uses the same release and preserves dirty work", async () => {
  const runId = "run_automatic";
  const tree = await provisionWorktree(
    { binding: "api", branch: "dirty" },
    { workflowRunId: runId },
  );
  const directory = await createRunDirectory({ workflowRunId: runId });
  writeFileSync(path.join(tree.path, "uncommitted.txt"), "keep me\n");
  const readState = (id: string) =>
    readRunState(sql(), currentFactoryContext().slug, id, async () => ({
      run: {
        status: "completed",
        workflowName: "workflow//./workflows/ship//ship",
        trigger: "manual",
        ticket: null,
        createdAt: new Date(),
      },
    }));
  const deps: AutomaticReleaseDeps = {
    pendingRuns: async () => [await readState(runId)],
    readState,
    waitForTerminal: async () => undefined,
    hasActiveStep: async () => false,
    policy: () => "release",
    withLock: (id, action) => withRunResourceLock(sql(), id, action),
    release: (locked, runId, action, outcome) =>
      releaseRun(locked, currentFactoryContext().slug, runId, action, outcome),
    ready: () => true,
    log: () => undefined,
    warn: () => undefined,
    setTimer: () => () => undefined,
  };

  expect((await reconcileAutomaticRelease({ workflows: {} } as Factory, deps)).released).toBe(1);
  expect(existsSync(path.join(tree.path, "uncommitted.txt"))).toBe(true);
  expect(existsSync(directory)).toBe(false);
  expect(await states(runId)).toEqual([
    ["worktree", "kept", "uncommitted work kept"],
    ["run-directory", "released", "removed"],
  ]);
  expect((await readState(runId)).resources.map((record) => record.state)).toEqual([
    "kept",
    "released",
  ]);
});

// GitHub serves every pull request's head as refs/pull/<n>/head on the base repository.
function pushPullRequestHead(number: number, file: string): string {
  const checkout = path.join(tmp, `pr-${number}-${file}`);
  git(tmp, "clone", "-q", remoteDir, checkout);
  git(checkout, "config", "user.name", "jigs-fixture");
  git(checkout, "config", "user.email", "fixture@jigs.test");
  writeFileSync(path.join(checkout, file), "bumped\n");
  git(checkout, "add", file);
  git(checkout, "commit", "-q", "-m", `bump ${file}`);
  git(checkout, "push", "-q", "origin", `+HEAD:refs/pull/${number}/head`);
  return git(checkout, "rev-parse", "HEAD");
}

dbTest("a pull request's worktree is its head commit, and each new head gets its own", async () => {
  const runId = "wrun_pullrq";
  const first = pushPullRequestHead(7, "first.txt");
  const tree = await provisionPullRequestWorktree(
    { binding: "api", number: 7 },
    { workflowRunId: runId },
  );
  expect(tree).toMatchObject({ binding: "api", installationName: "github-acme", headSha: first });
  expect(git(tree.path, "rev-parse", "HEAD")).toBe(first);
  expect(existsSync(path.join(tree.path, "first.txt"))).toBe(true);

  expect(isForkPullRequest).toHaveBeenCalledWith({
    installationName: "github-acme",
    owner: "acme",
    repo: "api",
    number: 7,
  });

  // A retry of the same step lands on the same tree, but not once it has changed.
  const retried = await provisionPullRequestWorktree(
    { binding: "api", number: 7 },
    { workflowRunId: runId },
  );
  expect(retried).toEqual(tree);
  writeFileSync(path.join(tree.path, "first.txt"), "edited\n");
  await expect(
    provisionPullRequestWorktree({ binding: "api", number: 7 }, { workflowRunId: runId }),
  ).rejects.toThrow("exists but is not a worktree");
  git(tree.path, "checkout", "--", "first.txt");

  const second = pushPullRequestHead(7, "second.txt");
  const next = await provisionPullRequestWorktree(
    { binding: "api", number: 7 },
    { workflowRunId: runId },
  );
  expect(next.headSha).toBe(second);
  expect(next.path).not.toBe(tree.path);

  writeFileSync(path.join(next.path, "uncommitted.txt"), "keep me\n");
  await withRunResourceLock(sql(), runId, (locked) =>
    releaseRun(locked, currentFactoryContext().slug, runId, "release", "success"),
  );
  expect(existsSync(tree.path)).toBe(false);
  expect(existsSync(next.path)).toBe(true);
  expect(await states(runId)).toEqual([
    ["worktree", "released", "worktree removed"],
    ["worktree", "kept", "uncommitted work kept"],
  ]);
});

dbTest("a pull request from a fork is never checked out, since setup runs its code", async () => {
  vi.mocked(isForkPullRequest).mockResolvedValueOnce(true);
  await expect(
    provisionPullRequestWorktree({ binding: "api", number: 8 }, { workflowRunId: "wrun_forked" }),
  ).rejects.toThrow("is not a branch of");
  expect(await states("wrun_forked")).toEqual([]);
});
