import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { GithubBranchProtection } from "../../providers/github-branch-protection.ts";
import { makeFactoryRepo, makeTmpDir, removeTmpDir } from "../../test-fixtures.ts";
import { type RepoSetupDeps, setupRepo } from "./repo-setup.ts";

let tmp: string;
let factory: string;
let lines: string[];

beforeEach(() => {
  tmp = makeTmpDir();
  lines = [];
});
afterEach(() => removeTmpDir(tmp));

function makeFactory(identity: "pat" | "app", approval: "label" | "review") {
  factory = makeFactoryRepo(tmp, {
    bindings: { api: { remote: "git@github.com:acme/api.git" } },
    github: {
      identity:
        identity === "pat"
          ? { mode: "pat" }
          : {
              mode: "app",
              appId: 1,
              installationId: 2,
              privateKeyPath: "app.pem",
              operator: "salim",
            },
    },
    merge: {
      by: "jigs",
      method: "squash",
      approval:
        approval === "label" ? { kind: "label", name: "jigs:approved" } : { kind: "review" },
    },
  });
}

function harness(current: GithubBranchProtection, confirm = vi.fn(async () => true)) {
  const put = vi.fn(async () => undefined);
  const protection: NonNullable<RepoSetupDeps["protection"]> = {
    defaultBranch: vi.fn(async () => "main"),
    get: vi.fn(async () => current),
    observedChecks: vi.fn(async () => ["test", "typecheck"]),
    put,
  };
  return {
    deps: { cwd: factory, out: (line: string) => lines.push(line), confirm, protection },
    protection,
    put,
    confirm,
  };
}

const unprotected = (): GithubBranchProtection => ({
  protected: false,
  requiredChecks: [],
  strictChecks: false,
  requiredApprovingReviews: 0,
});

test("App review mode proposes checks and one approving review, then prompts", async () => {
  makeFactory("app", "review");
  const { deps, put, confirm } = harness(unprotected());

  await expect(setupRepo("api", deps)).resolves.toBe("applied");

  expect(confirm).toHaveBeenCalledWith("Apply these repository rules?");
  expect(put).toHaveBeenCalledWith(
    "acme",
    "api",
    "main",
    expect.anything(),
    expect.objectContaining({ requiredChecks: ["test", "typecheck"], requiredApprovingReviews: 1 }),
  );
  expect(lines.join("\n")).toContain("configured approving GitHub review signal");
});

test("App label mode does not propose a required review", async () => {
  makeFactory("app", "label");
  const { deps, put } = harness(unprotected());

  await setupRepo("api", deps, { yes: true });

  expect(put).toHaveBeenCalledWith(
    "acme",
    "api",
    "main",
    expect.anything(),
    expect.objectContaining({ requiredApprovingReviews: 0 }),
  );
});

test("review mode preserves an operator's stronger review count", async () => {
  makeFactory("pat", "review");
  const { deps, put } = harness({
    ...unprotected(),
    protected: true,
    requiredApprovingReviews: 2,
  });

  await setupRepo("api", deps, { yes: true });

  expect(put).toHaveBeenCalledWith(
    "acme",
    "api",
    "main",
    expect.anything(),
    expect.objectContaining({ requiredApprovingReviews: 2 }),
  );
});

test("label mode refuses an existing review rule without deleting it", async () => {
  makeFactory("pat", "label");
  const current = {
    ...unprotected(),
    protected: true,
    requiredChecks: ["test"],
    requiredApprovingReviews: 2,
  };
  const { deps, put } = harness(current);

  await expect(setupRepo("api", deps, { yes: true })).rejects.toThrow("refusing to change");
  expect(put).not.toHaveBeenCalled();
});

test("--yes is unattended, while the default refuses to write without a prompt", async () => {
  makeFactory("pat", "label");
  const unattended = harness(unprotected());
  delete (unattended.deps as Partial<RepoSetupDeps>).confirm;

  await expect(setupRepo("api", unattended.deps)).rejects.toThrow("interactive terminal");
  expect(unattended.put).not.toHaveBeenCalled();
  await expect(setupRepo("api", unattended.deps, { yes: true })).resolves.toBe("applied");
  expect(unattended.put).toHaveBeenCalledOnce();
});

test("a declined plan makes no write", async () => {
  makeFactory("pat", "label");
  const { deps, put } = harness(
    unprotected(),
    vi.fn(async () => false),
  );

  await expect(setupRepo("api", deps)).resolves.toBe("declined");
  expect(put).not.toHaveBeenCalled();
  expect(lines).toContain("not applied");
});

test("the desired state is already set and causes no prompt or write", async () => {
  makeFactory("app", "review");
  const { deps, put, confirm, protection } = harness({
    protected: true,
    requiredChecks: ["test"],
    strictChecks: false,
    requiredApprovingReviews: 1,
  });

  await expect(setupRepo("api", deps)).resolves.toBe("already-set");
  expect(protection.observedChecks).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
  expect(lines).toContain("already set; no repository rules changed");
});

test("setup refuses to invent a status-check requirement when the branch has no checks", async () => {
  makeFactory("pat", "label");
  const harnessed = harness(unprotected());
  vi.mocked(harnessed.protection.observedChecks).mockResolvedValue([]);

  await expect(setupRepo("api", harnessed.deps, { yes: true })).rejects.toThrow(
    "no checks or commit statuses were found",
  );
  expect(harnessed.put).not.toHaveBeenCalled();
});
