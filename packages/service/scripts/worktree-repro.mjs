#!/usr/bin/env node
// Worktree-lifecycle acceptance repro (AGE-309), patterned on steps-repro.mjs.
// One pass, end to end against a scratch target repo it creates itself:
//   provision   worktree() creates, provisions from .jigs.yml (a .env lands),
//               and registers the tree
//   suspended   the run parks on a hook and KEEPS its worktree across a full
//               automatic sweep pass
//   teardown    after the run completes, the pass removes the worktree,
//               deletes the local and remote branches, and drops the row
// Requires `pnpm build`, compose Postgres up, bootstrap.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assert,
  createHarness,
  startProviderStub,
  waitFor,
  waitForLog,
} from "./repro-lib.mjs";

const BRANCH = `jigs/worktree-repro-${Date.now()}`;

const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  }).trim();

// A bare remote plus a checkout, bound in a throwaway factory repo.
const root = mkdtempSync(path.join(tmpdir(), "jigs-worktree-repro-"));
const remoteDir = path.join(root, "remote.git");
const checkout = path.join(root, "scratch");
const workspace = path.join(root, "worktrees");
const factory = path.join(root, "factory");
for (const dir of [remoteDir, checkout, factory])
  mkdirSync(dir, { recursive: true });

git(remoteDir, "init", "-q", "--bare", "--initial-branch", "main");
git(checkout, "init", "-q", "--initial-branch", "main");
git(checkout, "config", "user.name", "jigs-repro");
git(checkout, "config", "user.email", "repro@jigs.test");
git(checkout, "remote", "add", "origin", remoteDir);
writeFileSync(path.join(checkout, "README.md"), "# scratch\n");
writeFileSync(path.join(checkout, ".env"), "SECRET=from-the-checkout\n");
writeFileSync(
  path.join(checkout, ".jigs.yml"),
  'worktree:\n  copy: [.env]\n  post_create: ["echo provisioned > provisioned.txt"]\n',
);
git(checkout, "add", "README.md", ".jigs.yml");
git(checkout, "commit", "-q", "-m", "initial");
git(checkout, "push", "-q", "-u", "origin", "main");
git(checkout, "remote", "set-head", "origin", "main");

writeFileSync(
  path.join(factory, "jigs.yml"),
  `bindings:\n  scratch:\n    path: ${checkout}\n    remote: ${remoteDir}\n    workspace_dir: ${workspace}\n`,
);

const { startServer, healthy, ensurePortFree, api } = createHarness({
  port: process.env.PORT ?? "8995",
  env: {
    ...(await startProviderStub()),
    JIGS_FACTORY_ROOT: factory,
    // Fast enough to observe within the repro, slow enough not to race it.
    JIGS_SWEEP_INTERVAL_MS: "3000",
  },
});

await ensurePortFree();
const server = startServer("worktree");
await healthy();

const trigger = await api("/api/pipelines/worktree-demo/runs", {
  inputs: { binding: "scratch", branch: BRANCH },
});
console.log(`  triggered: ${JSON.stringify(trigger)}`);
assert(typeof trigger.runId === "string", "the trigger created a run");

const provisioned = await waitForLog(
  server,
  /\[worktree-demo\] provisioned (\S+) on/,
);
const worktreePath = provisioned[1];
assert(existsSync(worktreePath), `the worktree exists at ${worktreePath}`);
assert(
  existsSync(path.join(worktreePath, ".env")),
  "the .env listed in copy landed in the worktree (dotfile glob)",
);
assert(
  existsSync(path.join(worktreePath, ".jigs.yml")),
  ".jigs.yml self-copied into the worktree",
);
assert(
  existsSync(path.join(worktreePath, "provisioned.txt")),
  "post_create ran in the worktree",
);

// A suspended run is not terminal: a full sweep pass must leave it alone.
const swept = await api("/api/worktrees/sweep", { clean: true, force: true });
const held = swept.entries.find((e) => e.path === worktreePath);
assert(held?.state === "held", `the suspended run's worktree is held`);
assert(existsSync(worktreePath), "the suspended run still has its worktree");

const resumed = await waitFor(async () => {
  const res = await api("/api/hooks/resume", {
    token: trigger.resumeToken,
    payload: { note: "worktree-repro" },
  });
  return res.resumed === true ? res : null;
}, "hook to accept the resume");
assert(resumed.resumed === true, "resumeHook accepted the token");

await waitFor(async () => {
  const run = await api(`/api/runs/${trigger.runId}`);
  return run.status === "completed" ? run : null;
}, "run completion");

// The automatic pass is on a timer; the same function answers this route.
const teardown = await waitFor(async () => {
  const report = await api("/api/worktrees/sweep", { clean: true });
  return report.removed.includes(worktreePath) || !existsSync(worktreePath)
    ? report
    : null;
}, "the completed run's worktree to be torn down");
assert(!existsSync(worktreePath), "the worktree was removed");
assert(
  !teardown.entries.some((e) => e.path === worktreePath && e.state === "held"),
  "the registry row is gone",
);
assert(
  git(checkout, "branch", "--list", BRANCH) === "",
  "the local branch was deleted",
);
assert(
  git(checkout, "ls-remote", "--heads", "origin", BRANCH) === "",
  "the remote branch was deleted (idempotently)",
);

console.log("\nPASS: worktree lifecycle");
server.child.kill("SIGKILL");
process.exit(0);
