import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { makeTmpDir, removeTmpDir } from "../../test-fixtures.ts";
import { checkFactoryIntegration } from "../integration.ts";
import { type Call, execError, fakeExec, factory as scaffold } from "./test-fixtures.ts";
import { upFactory } from "./up.ts";
import { type UpgradeOptions, upgradeFactory } from "./upgrade.ts";

vi.mock("./up.ts", async (original) => ({
  ...(await original<typeof import("./up.ts")>()),
  upFactory: vi.fn(() => {
    throw new Error("upgrade ran up in the process that installed the release");
  }),
}));

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

interface Manifest {
  dependencies: Record<string, string>;
  scripts?: Record<string, string>;
}

const PUBLISHED = { "@jigs-ai/jigs": "0.1.18" };

function factory(
  manifest: Manifest = {
    dependencies: PUBLISHED,
    scripts: { typecheck: "tsc --noEmit" },
  },
): string {
  const root = scaffold(tmp, { port: 1 });
  writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest, null, 2));
  return root;
}

const readManifest = (root: string): Manifest =>
  JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

// The registry as far as `upgrade` can tell: the fake pnpm rewrites
// package.json the way `pnpm update` does, to `latest` or to the pinned spec.
function fakeRegistry(latest: string, fail?: (call: Call) => Error | undefined) {
  return fakeExec((call) => {
    const err = fail?.(call);
    if (err !== undefined) return err;
    if (call.file !== "pnpm" || call.args[0] !== "update") return undefined;
    const manifest = readManifest(call.options.cwd);
    for (const spec of call.args.slice(1)) {
      if (spec.startsWith("--")) continue;
      const at = spec.lastIndexOf("@");
      const [name, version] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, latest];
      manifest.dependencies[name] = version;
    }
    writeFileSync(path.join(call.options.cwd, "package.json"), JSON.stringify(manifest, null, 2));
    return undefined;
  });
}

function upgrade(
  root: string,
  io: { exec: ReturnType<typeof fakeExec> },
  options: UpgradeOptions = {},
) {
  return upgradeFactory(
    { cwd: root, out: (line) => lines.push(line), execFile: io.exec.execFile },
    options,
  );
}

const statuses = (result: Awaited<ReturnType<typeof upgradeFactory>>) =>
  result.steps.map((step) => `${step.name}:${step.status}`);

const commands = (io: { exec: ReturnType<typeof fakeExec> }) =>
  io.exec.calls.map((call) => [path.basename(call.file), ...call.args]);

test("bumps jigs to latest, then generates and runs up under the new CLI, then typechecks", async () => {
  const root = factory();
  const io = {
    exec: fakeRegistry("0.1.19", (call) => {
      if (call.args[0] === "exec") {
        expect(readManifest(root).dependencies["@jigs-ai/jigs"]).toBe("0.1.19");
      }
      return undefined;
    }),
  };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(true);
  expect(statuses(result)).toEqual([
    "packages:ok",
    "bump:ok",
    "generate:ok",
    "up:ok",
    "typecheck:ok",
  ]);
  expect(result.before).toBe("0.1.18");
  expect(result.after).toBe("0.1.19");

  expect(commands(io)).toEqual([
    ["pnpm", "update", "--latest", "@jigs-ai/jigs"],
    ["pnpm", "exec", "jigs", "generate"],
    ["pnpm", "exec", "jigs", "up"],
    ["pnpm", "run", "typecheck"],
  ]);
  for (const call of io.exec.calls) expect(call.options.cwd).toBe(root);
  const upCall = io.exec.calls.find((call) => call.args.join(" ") === "exec jigs up");
  expect(upCall?.options.stdio).toBe("inherit");

  const printed = lines.join("\n");
  expect(printed).toMatch(
    /^ok {3}packages \(\d+ms\) — jigs 0\.1\.18; normalized minimumReleaseAgeExclude$/m,
  );
  expect(printed).toMatch(/^ok {3}bump \(\d+ms\) — jigs 0\.1\.18 → 0\.1\.19$/m);
  expect(printed).toMatch(/^ok {3}typecheck \(\d+ms\)$/m);
  expect(lines.at(-1)).toBe("acme-factory runs jigs 0.1.19");
});

// The bug this guards: the process that ran the bump holds the old release's
// integration template, so an in-process build rejected the jigs/ files the new
// release had just generated and left the factory half-upgraded.
test("each change the new release's generate reports reaches the operator", async () => {
  const root = factory();
  const io = {
    exec: fakeRegistry("0.1.19", (call) => {
      if (call.args.join(" ") === "exec jigs generate") {
        call.options.onLine?.("deleted jigs.ts; its steps now live in jigs/steps.ts");
        call.options.onLine?.("removed #jigs from package.json imports");
      }
      return undefined;
    }),
  };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(true);
  expect(lines).toContain("  deleted jigs.ts; its steps now live in jigs/steps.ts");
  expect(lines).toContain("  removed #jigs from package.json imports");
});

test("generated files the old CLI would reject do not stop the upgrade", async () => {
  const root = factory();
  const io = {
    exec: fakeRegistry("0.1.19", (call) => {
      if (call.args.join(" ") === "exec jigs generate") {
        mkdirSync(path.join(root, "jigs"), { recursive: true });
        writeFileSync(path.join(root, "jigs/steps.ts"), "// generated by jigs 0.1.19\n");
      }
      return undefined;
    }),
  };

  const result = await upgrade(root, io);

  expect(() => checkFactoryIntegration(root)).toThrow(/differs from the installed jigs/);
  expect(result.ok).toBe(true);
  expect(upFactory).not.toHaveBeenCalled();
});

test("normalizes an exact jigs release-age exclusion before pnpm runs", async () => {
  const root = factory();
  const workspace = path.join(root, "pnpm-workspace.yaml");
  writeFileSync(
    workspace,
    "minimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - '@acme/fresh@1.0.0' # preserve me\n  - '@jigs-ai/jigs@0.1.18'\n",
  );
  const io = {
    exec: fakeRegistry("0.1.19", (call) => {
      if (call.file !== "pnpm") return undefined;
      const contents = readFileSync(workspace, "utf8");
      expect(contents).toContain("@acme/fresh@1.0.0");
      expect(contents).toMatch(/- '@jigs-ai\/jigs'$/m);
      expect(contents).not.toContain("@jigs-ai/jigs@0.1.18");
      return undefined;
    }),
  };

  const result = await upgrade(root, io, { to: "0.1.19" });

  expect(result.ok).toBe(true);
  expect(result.steps[0]?.detail).toBe("jigs 0.1.18; normalized minimumReleaseAgeExclude");
  const contents = readFileSync(workspace, "utf8");
  expect(contents).toContain("minimumReleaseAge: 1440");
  expect(contents).toContain("'@acme/fresh@1.0.0' # preserve me");
  expect(contents.match(/'@jigs-ai\/jigs'(?:\n|$)/g)).toHaveLength(1);
});

test("rewrites an exact exclusion in place with its comment and position", async () => {
  const root = factory();
  const workspace = path.join(root, "pnpm-workspace.yaml");
  writeFileSync(
    workspace,
    "minimumReleaseAgeExclude:\n  # jigs, freshly published\n  - '@jigs-ai/jigs@0.1.18'\n  - 'zod@1.0.0'\n",
  );
  const io = { exec: fakeRegistry("0.1.19") };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(true);
  expect(readFileSync(workspace, "utf8")).toBe(
    "minimumReleaseAgeExclude:\n  # jigs, freshly published\n  - '@jigs-ai/jigs'\n  - 'zod@1.0.0'\n",
  );
});

test("normalizes an exact jigs exclusion in a flow-style list", async () => {
  const root = factory();
  const workspace = path.join(root, "pnpm-workspace.yaml");
  writeFileSync(
    workspace,
    "minimumReleaseAgeExclude: ['@acme/fresh@1.0.0', '@jigs-ai/jigs@0.1.18']\n",
  );
  const io = { exec: fakeRegistry("0.1.19") };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(true);
  expect(readFileSync(workspace, "utf8")).toBe(
    "minimumReleaseAgeExclude: [ '@acme/fresh@1.0.0', '@jigs-ai/jigs' ]\n",
  );
});

test("removes stale jigs exclusions beside the wildcard", async () => {
  const root = factory();
  const workspace = path.join(root, "pnpm-workspace.yaml");
  writeFileSync(
    workspace,
    "minimumReleaseAgeExclude:\n  - '@jigs-ai/jigs'\n  - '@acme/fresh@1.0.0'\n  - '@jigs-ai/jigs@0.1.18'\n",
  );
  const io = { exec: fakeRegistry("0.1.19") };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(true);
  expect(result.steps[0]?.detail).toBe("jigs 0.1.18; normalized minimumReleaseAgeExclude");
  expect(readFileSync(workspace, "utf8")).toBe(
    "minimumReleaseAgeExclude:\n  - '@jigs-ai/jigs'\n  - '@acme/fresh@1.0.0'\n",
  );
});

test("adds a release-age exclusion when the workspace has no exclusion list", async () => {
  const root = factory();
  const workspace = path.join(root, "pnpm-workspace.yaml");
  const before = "packages:\n  - src/*\n# operator setting\nstrictPeerDependencies: true\n";
  writeFileSync(workspace, before);
  const io = { exec: fakeRegistry("0.1.19") };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(true);
  const contents = readFileSync(workspace, "utf8");
  expect(contents).toContain(before);
  expect(contents).toMatch(/minimumReleaseAgeExclude:\n {2}- '@jigs-ai\/jigs'$/m);
  expect(contents).not.toContain("minimumReleaseAge:");
});

test("treats an empty release-age exclusion value as an empty list", async () => {
  const root = factory();
  const workspace = path.join(root, "pnpm-workspace.yaml");
  writeFileSync(workspace, "minimumReleaseAgeExclude:\n");
  const io = { exec: fakeRegistry("0.1.19") };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(true);
  expect(readFileSync(workspace, "utf8")).toBe("minimumReleaseAgeExclude:\n  - '@jigs-ai/jigs'\n");
});

test("reports a non-mapping workspace file with a repair hint", async () => {
  const root = factory();
  const workspace = path.join(root, "pnpm-workspace.yaml");
  writeFileSync(workspace, "- packages\n");
  const io = { exec: fakeRegistry("0.1.19") };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(false);
  expect(statuses(result)).toEqual(["packages:failed"]);
  expect(result.steps[0]?.detail).toBe(`${workspace} must contain a YAML mapping`);
  expect(result.steps[0]?.repair).toBe(
    "make pnpm-workspace.yaml a top-level mapping, then run pnpm exec jigs upgrade again",
  );
  expect(io.exec.calls).toHaveLength(0);
});

test("leaves an already-normalized release-age exclusion byte-identical", async () => {
  const root = factory();
  const workspace = path.join(root, "pnpm-workspace.yaml");
  const before =
    "minimumReleaseAgeExclude:\n  - '@acme/fresh@1.0.0'\n  - '@jigs-ai/jigs' # all releases\n";
  writeFileSync(workspace, before);
  const io = { exec: fakeRegistry("0.1.19") };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(true);
  expect(result.steps[0]?.detail).toBe("jigs 0.1.18");
  expect(readFileSync(workspace, "utf8")).toBe(before);
});

test("leaves a normalized exclusion byte-identical when jigs is not last", async () => {
  const root = factory();
  const workspace = path.join(root, "pnpm-workspace.yaml");
  const before =
    "minimumReleaseAgeExclude:\n  - '@jigs-ai/jigs' # all releases\n  - '@acme/fresh@1.0.0'\n";
  writeFileSync(workspace, before);
  const io = { exec: fakeRegistry("0.1.19") };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(true);
  expect(result.steps[0]?.detail).toBe("jigs 0.1.18");
  expect(readFileSync(workspace, "utf8")).toBe(before);
});

test("--to-version pins jigs to that version instead of the latest", async () => {
  const root = factory();
  const io = { exec: fakeRegistry("0.3.0") };

  const result = await upgrade(root, io, { to: "0.2.0" });

  expect(result.ok).toBe(true);
  expect(commands(io)[0]).toEqual(["pnpm", "update", "@jigs-ai/jigs@0.2.0"]);
  expect(readManifest(root).dependencies).toEqual({
    "@jigs-ai/jigs": "0.2.0",
  });
});

test("--to-version that is not an exact version is refused before anything runs", async () => {
  const root = factory();
  const io = { exec: fakeRegistry("0.1.19") };

  await expect(upgrade(root, io, { to: "latest" })).rejects.toThrow(
    "--to-version takes an exact version",
  );
  expect(io.exec.calls).toHaveLength(0);
});

test("a factory already on the latest says so and still runs up and the typecheck", async () => {
  const root = factory();
  const io = { exec: fakeRegistry("0.1.18") };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(true);
  expect(lines.join("\n")).toMatch(/^ok {3}bump .* — jigs 0\.1\.18 \(unchanged\)$/m);
  expect(statuses(result).at(-1)).toBe("typecheck:ok");
});

test("a factory linked to a checkout is refused before pnpm runs, naming the published package", async () => {
  const root = factory({
    dependencies: {
      "@jigs/service": "link:/home/me/jigs/packages/service",
      jigs: "link:/home/me/jigs/packages/jigs",
      workflow: "4.8.4",
    },
  });
  const io = { exec: fakeRegistry("0.1.19") };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(false);
  expect(statuses(result)).toEqual(["packages:failed"]);
  expect(result.steps[0]?.detail).toBe(
    "this factory installs jigs from a checkout (@jigs/service: link:/home/me/jigs/packages/service, jigs: link:/home/me/jigs/packages/jigs)",
  );
  expect(result.steps[0]?.repair).toContain("@jigs-ai/jigs from npm");
  expect(io.exec.calls).toHaveLength(0);
});

test("a published name still linked by path counts as a checkout install", async () => {
  const root = factory({
    dependencies: { "@jigs-ai/jigs": "link:../jigs/packages/jigs" },
  });
  const io = { exec: fakeRegistry("0.1.19") };

  const result = await upgrade(root, io);

  expect(statuses(result)).toEqual(["packages:failed"]);
  expect(result.steps[0]?.detail).toContain("@jigs-ai/jigs: link:");
});

test("a link: to something other than jigs is not a checkout install", async () => {
  const root = factory({
    dependencies: { ...PUBLISHED, "acme-tools": "link:../acme-tools" },
    scripts: { typecheck: "tsc --noEmit" },
  });
  const io = { exec: fakeRegistry("0.1.19") };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(true);
  expect(readManifest(root).dependencies["acme-tools"]).toBe("link:../acme-tools");
});

test("a factory that does not depend on jigs is told so, since pnpm would silently skip it", async () => {
  const root = factory({ dependencies: { workflow: "4.8.4" } });
  const io = { exec: fakeRegistry("0.1.19") };

  const result = await upgrade(root, io);

  expect(statuses(result)).toEqual(["packages:failed"]);
  expect(result.steps[0]?.detail).toBe("@jigs-ai/jigs not in this factory's package.json");
  expect(io.exec.calls).toHaveLength(0);
});

// The one state an upgrade cannot repair: the factory's imports name a
// package no release has, so pnpm would resolve nothing and the rewrite is
// the operator's.
test("a factory still on the two-package split is sent to the one-time migration", async () => {
  const root = factory({
    dependencies: {
      "@jigs-ai/jigs": "0.2.0",
      "@salimhamed/jigs-service": "0.2.0",
    },
  });
  const io = { exec: fakeRegistry("0.3.0") };

  const result = await upgrade(root, io);

  expect(statuses(result)).toEqual(["packages:failed"]);
  expect(result.steps[0]?.detail).toBe(
    "this factory still depends on @salimhamed/jigs-service, which no longer releases",
  );
  expect(result.steps[0]?.repair).toContain(
    "rewrite every import of @salimhamed/jigs-service/X to @jigs-ai/jigs/X",
  );
  expect(io.exec.calls).toHaveLength(0);
});

test("a factory still on the GitHub Packages name is sent to the one-time rename", async () => {
  const root = factory({ dependencies: { "@salimhamed/jigs": "0.47.2" } });
  const io = { exec: fakeRegistry("0.48.0") };

  const result = await upgrade(root, io);

  expect(statuses(result)).toEqual(["packages:failed"]);
  expect(result.steps[0]?.detail).toBe(
    "this factory still depends on @salimhamed/jigs, which no longer releases",
  );
  expect(result.steps[0]?.repair).toContain(
    "rewrite every import of @salimhamed/jigs/X to @jigs-ai/jigs/X",
  );
  expect(io.exec.calls).toHaveLength(0);
});

test("outside a factory repo, packages fails with the existing error", async () => {
  const io = { exec: fakeRegistry("0.1.19") };
  const result = await upgrade(tmp, io);
  expect(statuses(result)).toEqual(["packages:failed"]);
  expect(result.steps[0]?.detail).toContain("not inside a factory repo");
});

test("a peer the new release moved fails the bump and names the factory-supplied runtime", async () => {
  const root = factory();
  const io = {
    exec: fakeRegistry("0.1.19", (call) =>
      call.args[0] === "update"
        ? execError(
            1,
            "ERR_PNPM_PEER_DEP_ISSUES  Unmet peer dependencies\n. └─┬ @jigs-ai/jigs 0.1.19\n   └── ✕ unmet peer workflow@4.9.0: found 4.8.4\n",
          )
        : undefined,
    ),
  };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(false);
  expect(statuses(result)).toEqual(["packages:ok", "bump:failed"]);
  expect(result.steps[1]?.detail).toContain("peers on a runtime version");
  expect(result.steps[1]?.repair).toContain("@workflow/world-postgres");
  expect(lines).toContain("     └── ✕ unmet peer workflow@4.9.0: found 4.8.4");
  expect(io.exec.calls).toHaveLength(1);
});

test("a version the registry does not have is named with the --to-version that asked for it", async () => {
  const root = factory();
  const io = {
    exec: fakeRegistry("0.1.19", (call) =>
      call.args[0] === "update"
        ? execError(
            1,
            "ERR_PNPM_NO_MATCHING_VERSION  No matching version found for @jigs-ai/jigs@9.9.9\n",
          )
        : undefined,
    ),
  };

  const result = await upgrade(root, io, { to: "9.9.9" });

  expect(statuses(result).at(-1)).toBe("bump:failed");
  expect(result.steps.at(-1)?.detail).toContain("at 9.9.9");
});

test("pnpm missing from PATH is named at the bump", async () => {
  const root = factory();
  const io = {
    exec: fakeRegistry("0.1.19", (call) =>
      call.file === "pnpm" ? execError("ENOENT") : undefined,
    ),
  };

  const result = await upgrade(root, io);

  expect(statuses(result)).toEqual(["packages:ok", "bump:failed"]);
  expect(result.steps[1]?.repair).toContain("install pnpm");
});

test("a failing jigs up ends the upgrade there, names the command to re-run, and skips typecheck", async () => {
  const root = factory();
  const io = {
    exec: fakeRegistry("0.1.19", (call) =>
      call.args.slice(0, 3).join(" ") === "exec jigs up" ? execError(1) : undefined,
    ),
  };

  const result = await upgrade(root, io, { force: true });

  expect(result.ok).toBe(false);
  expect(statuses(result)).toEqual(["packages:ok", "bump:ok", "generate:ok", "up:failed"]);
  expect(result.steps.at(-1)?.detail).toBe(`jigs up failed in ${root}`);
  expect(result.steps.at(-1)?.repair).toBe(
    "fix what jigs up reported above, then run pnpm exec jigs up --force and pnpm run typecheck in this factory",
  );
  expect(commands(io).map((c) => c.join(" "))).not.toContain("pnpm run typecheck");
});

test("a red typecheck reports custom factory code errors after refreshing the integration", async () => {
  const root = factory();
  const io = {
    exec: fakeRegistry("0.1.19", (call) =>
      call.args[0] === "run" && call.args[1] === "typecheck"
        ? execError(
            2,
            "steps/custom.ts(12,3): error TS2305: Module '@jigs-ai/jigs/steps' has no exported member 'removedOperation'.\n",
          )
        : undefined,
    ),
  };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(false);
  expect(statuses(result).at(-1)).toBe("typecheck:failed");
  expect(result.steps.at(-1)?.repair).toContain("custom factory code");
  expect(lines.join("\n")).toContain("error TS2305");
  expect(lines.at(-2)).toBe(`FAIL typecheck: typecheck failed in ${root}`);
  // The service already runs the new bundle; that is what the red line is for.
  expect(statuses(result)).toContain("up:ok");
});

test("without a typecheck script the step is skipped and says so", async () => {
  const root = factory({ dependencies: PUBLISHED });
  const io = { exec: fakeRegistry("0.1.19") };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(true);
  expect(statuses(result).at(-1)).toBe("typecheck:skipped");
  expect(lines).toContain("skip typecheck — no typecheck script in package.json");
  expect(commands(io).map((c) => c.join(" "))).not.toContain("pnpm run typecheck");
});

test("--force and --no-doctor reach jigs up", async () => {
  const root = factory();
  const io = { exec: fakeRegistry("0.1.19") };

  const result = await upgrade(root, io, { force: true, doctor: false });

  expect(result.ok).toBe(true);
  expect(commands(io)).toContainEqual(["pnpm", "exec", "jigs", "up", "--force", "--no-doctor"]);
});

test("a failed integration refresh stops before rebuilding or restarting", async () => {
  const root = factory();
  const io = {
    exec: fakeRegistry("0.1.19", (call) =>
      call.args.join(" ") === "exec jigs generate" ? execError(1, "generation failed") : undefined,
    ),
  };
  const result = await upgrade(root, io);
  expect(result.ok).toBe(false);
  expect(statuses(result)).toEqual(["packages:ok", "bump:ok", "generate:failed"]);
  expect(result.steps.at(-1)?.detail).toBe("could not refresh jigs/");
  expect(result.steps.at(-1)?.repair).toBe("run pnpm exec jigs generate in this factory");
  expect(lines.at(-1)).toBe("  → run pnpm exec jigs generate in this factory");
  expect(commands(io)).toEqual([
    ["pnpm", "update", "--latest", "@jigs-ai/jigs"],
    ["pnpm", "exec", "jigs", "generate"],
  ]);
});

test("a missing pnpm during integration refresh names the missing tool", async () => {
  const root = factory();
  const io = {
    exec: fakeRegistry("0.1.19", (call) =>
      call.args.join(" ") === "exec jigs generate" ? execError("ENOENT") : undefined,
    ),
  };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(false);
  expect(statuses(result).at(-1)).toBe("generate:failed");
  expect(result.steps.at(-1)?.detail).toBe("pnpm is not on PATH");
  expect(result.steps.at(-1)?.repair).toBe("install pnpm");
  expect(lines.at(-1)).toBe("  → install pnpm");
});
