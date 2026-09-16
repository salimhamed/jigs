import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { makeTmpDir, removeTmpDir } from "../../test-fixtures.ts";
import {
  type Call,
  closeFakeServices,
  execError,
  type FakeProcesses,
  fakeExec,
  fakeProcesses,
  fakeService,
  factory as scaffold,
} from "./test-fixtures.ts";
import { type UpgradeDeps, type UpgradeOptions, upgradeFactory } from "./upgrade.ts";

let tmp: string;
let lines: string[];

beforeEach(() => {
  tmp = makeTmpDir();
  lines = [];
  vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  closeFakeServices();
  removeTmpDir(tmp);
});

interface Manifest {
  dependencies: Record<string, string>;
  scripts?: Record<string, string>;
}

const PUBLISHED = { "@salimhamed/jigs": "0.1.18" };

function factory(
  port: number,
  manifest: Manifest = {
    dependencies: PUBLISHED,
    scripts: { typecheck: "tsc --noEmit" },
  },
): string {
  const root = scaffold(tmp, { port });
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
  io: { exec: ReturnType<typeof fakeExec>; procs: FakeProcesses },
  options: UpgradeOptions = {},
  extra: Partial<UpgradeDeps> = {},
) {
  return upgradeFactory(
    {
      cwd: root,
      out: (line) => lines.push(line),
      execFile: io.exec.execFile,
      processes: io.procs.processes,
      prepare: vi.fn(),
      readyTimeoutMs: 500,
      ...extra,
    },
    options,
  );
}

const statuses = (result: Awaited<ReturnType<typeof upgradeFactory>>) =>
  result.steps.map((step) => `${step.name}:${step.status}`);

const commands = (io: { exec: ReturnType<typeof fakeExec> }) =>
  io.exec.calls.map((call) => [path.basename(call.file), ...call.args]);

test("bumps jigs to latest, runs every up step, then the typecheck", async () => {
  const port = await fakeService();
  const root = factory(port);
  const generated = path.join(root, "generated-by-new-release");
  const io = {
    exec: fakeRegistry("0.1.19", (call) => {
      if (call.args.join(" ") !== "exec jigs generate") return undefined;
      expect(readManifest(root).dependencies["@salimhamed/jigs"]).toBe("0.1.19");
      writeFileSync(generated, "new template");
      return undefined;
    }),
    procs: fakeProcesses(),
  };
  const result = await upgrade(
    root,
    io,
    {},
    {
      prepare: vi.fn(() => {
        expect(readFileSync(generated, "utf8")).toBe("new template");
      }),
    },
  );

  expect(result.ok).toBe(true);
  expect(statuses(result)).toEqual([
    "packages:ok",
    "bump:ok",
    "locate:ok",
    "env:ok",
    "install:ok",
    "generate:ok",
    "compose:ok",
    "bootstrap:ok",
    "build:ok",
    "service:ok",
    "ready:ok",
    "doctor:ok",
    "typecheck:ok",
  ]);
  expect(result.before).toBe("0.1.18");
  expect(result.after).toBe("0.1.19");
  expect(result.up?.service).toBe("started");

  expect(commands(io)).toEqual([
    ["pnpm", "update", "--latest", "@salimhamed/jigs"],
    ["pnpm", "install"],
    ["pnpm", "exec", "jigs", "generate"],
    ["docker", "compose", "up", "-d", "--wait"],
    ["bootstrap"],
    ["nitro", "build"],
    ["pnpm", "run", "typecheck"],
  ]);
  for (const call of io.exec.calls) expect(call.options.cwd).toBe(root);

  const printed = lines.join("\n");
  expect(printed).toMatch(
    /^ok {3}packages \(\d+ms\) — jigs 0\.1\.18; normalized minimumReleaseAgeExclude$/m,
  );
  expect(printed).toMatch(/^ok {3}bump \(\d+ms\) — jigs 0\.1\.18 → 0\.1\.19$/m);
  expect(printed).toMatch(/^ok {3}typecheck \(\d+ms\)$/m);
  expect(lines.at(-1)).toBe("acme-factory runs jigs 0.1.19");
});

test("normalizes an exact jigs release-age exclusion before pnpm runs", async () => {
  const port = await fakeService();
  const root = factory(port);
  const workspace = path.join(root, "pnpm-workspace.yaml");
  writeFileSync(
    workspace,
    "minimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - '@acme/fresh@1.0.0' # preserve me\n  - '@salimhamed/jigs@0.1.18'\n",
  );
  const io = {
    exec: fakeRegistry("0.1.19", (call) => {
      if (call.file !== "pnpm") return undefined;
      const contents = readFileSync(workspace, "utf8");
      expect(contents).toContain("@acme/fresh@1.0.0");
      expect(contents).toMatch(/- '@salimhamed\/jigs'$/m);
      expect(contents).not.toContain("@salimhamed/jigs@0.1.18");
      return undefined;
    }),
    procs: fakeProcesses(),
  };

  const result = await upgrade(root, io, { to: "0.1.19" });

  expect(result.ok).toBe(true);
  expect(result.steps[0]?.detail).toBe("jigs 0.1.18; normalized minimumReleaseAgeExclude");
  const contents = readFileSync(workspace, "utf8");
  expect(contents).toContain("minimumReleaseAge: 1440");
  expect(contents).toContain("'@acme/fresh@1.0.0' # preserve me");
  expect(contents.match(/'@salimhamed\/jigs'(?:\n|$)/g)).toHaveLength(1);
});

test("rewrites an exact exclusion in place with its comment and position", async () => {
  const port = await fakeService();
  const root = factory(port);
  const workspace = path.join(root, "pnpm-workspace.yaml");
  writeFileSync(
    workspace,
    "minimumReleaseAgeExclude:\n  # jigs, freshly published\n  - '@salimhamed/jigs@0.1.18'\n  - 'zod@1.0.0'\n",
  );
  const io = { exec: fakeRegistry("0.1.19"), procs: fakeProcesses() };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(true);
  expect(readFileSync(workspace, "utf8")).toBe(
    "minimumReleaseAgeExclude:\n  # jigs, freshly published\n  - '@salimhamed/jigs'\n  - 'zod@1.0.0'\n",
  );
});

test("normalizes an exact jigs exclusion in a flow-style list", async () => {
  const port = await fakeService();
  const root = factory(port);
  const workspace = path.join(root, "pnpm-workspace.yaml");
  writeFileSync(
    workspace,
    "minimumReleaseAgeExclude: ['@acme/fresh@1.0.0', '@salimhamed/jigs@0.1.18']\n",
  );
  const io = { exec: fakeRegistry("0.1.19"), procs: fakeProcesses() };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(true);
  expect(readFileSync(workspace, "utf8")).toBe(
    "minimumReleaseAgeExclude: [ '@acme/fresh@1.0.0', '@salimhamed/jigs' ]\n",
  );
});

test("removes stale jigs exclusions beside the wildcard", async () => {
  const port = await fakeService();
  const root = factory(port);
  const workspace = path.join(root, "pnpm-workspace.yaml");
  writeFileSync(
    workspace,
    "minimumReleaseAgeExclude:\n  - '@salimhamed/jigs'\n  - '@acme/fresh@1.0.0'\n  - '@salimhamed/jigs@0.1.18'\n",
  );
  const io = { exec: fakeRegistry("0.1.19"), procs: fakeProcesses() };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(true);
  expect(result.steps[0]?.detail).toBe("jigs 0.1.18; normalized minimumReleaseAgeExclude");
  expect(readFileSync(workspace, "utf8")).toBe(
    "minimumReleaseAgeExclude:\n  - '@salimhamed/jigs'\n  - '@acme/fresh@1.0.0'\n",
  );
});

test("adds a release-age exclusion when the workspace has no exclusion list", async () => {
  const port = await fakeService();
  const root = factory(port);
  const workspace = path.join(root, "pnpm-workspace.yaml");
  const before = "packages:\n  - src/*\n# operator setting\nstrictPeerDependencies: true\n";
  writeFileSync(workspace, before);
  const io = { exec: fakeRegistry("0.1.19"), procs: fakeProcesses() };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(true);
  const contents = readFileSync(workspace, "utf8");
  expect(contents).toContain(before);
  expect(contents).toMatch(/minimumReleaseAgeExclude:\n {2}- '@salimhamed\/jigs'$/m);
  expect(contents).not.toContain("minimumReleaseAge:");
});

test("treats an empty release-age exclusion value as an empty list", async () => {
  const port = await fakeService();
  const root = factory(port);
  const workspace = path.join(root, "pnpm-workspace.yaml");
  writeFileSync(workspace, "minimumReleaseAgeExclude:\n");
  const io = { exec: fakeRegistry("0.1.19"), procs: fakeProcesses() };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(true);
  expect(readFileSync(workspace, "utf8")).toBe(
    "minimumReleaseAgeExclude:\n  - '@salimhamed/jigs'\n",
  );
});

test("reports a non-mapping workspace file with a repair hint", async () => {
  const root = factory(1);
  const workspace = path.join(root, "pnpm-workspace.yaml");
  writeFileSync(workspace, "- packages\n");
  const io = { exec: fakeRegistry("0.1.19"), procs: fakeProcesses() };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(false);
  expect(statuses(result)).toEqual(["packages:failed"]);
  expect(result.steps[0]?.detail).toBe(`${workspace} must contain a YAML mapping`);
  expect(result.steps[0]?.repair).toBe(
    "make pnpm-workspace.yaml a top-level mapping, then run jigs upgrade again",
  );
  expect(io.exec.calls).toHaveLength(0);
});

test("leaves an already-normalized release-age exclusion byte-identical", async () => {
  const port = await fakeService();
  const root = factory(port);
  const workspace = path.join(root, "pnpm-workspace.yaml");
  const before =
    "minimumReleaseAgeExclude:\n  - '@acme/fresh@1.0.0'\n  - '@salimhamed/jigs' # all releases\n";
  writeFileSync(workspace, before);
  const io = { exec: fakeRegistry("0.1.19"), procs: fakeProcesses() };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(true);
  expect(result.steps[0]?.detail).toBe("jigs 0.1.18");
  expect(readFileSync(workspace, "utf8")).toBe(before);
});

test("leaves a normalized exclusion byte-identical when jigs is not last", async () => {
  const port = await fakeService();
  const root = factory(port);
  const workspace = path.join(root, "pnpm-workspace.yaml");
  const before =
    "minimumReleaseAgeExclude:\n  - '@salimhamed/jigs' # all releases\n  - '@acme/fresh@1.0.0'\n";
  writeFileSync(workspace, before);
  const io = { exec: fakeRegistry("0.1.19"), procs: fakeProcesses() };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(true);
  expect(result.steps[0]?.detail).toBe("jigs 0.1.18");
  expect(readFileSync(workspace, "utf8")).toBe(before);
});

test("--to pins jigs to that version instead of the latest", async () => {
  const port = await fakeService();
  const root = factory(port);
  const io = { exec: fakeRegistry("0.3.0"), procs: fakeProcesses() };

  const result = await upgrade(root, io, { to: "0.2.0" });

  expect(result.ok).toBe(true);
  expect(commands(io)[0]).toEqual(["pnpm", "update", "@salimhamed/jigs@0.2.0"]);
  expect(readManifest(root).dependencies).toEqual({
    "@salimhamed/jigs": "0.2.0",
  });
});

test("--to that is not an exact version is refused before anything runs", async () => {
  const root = factory(1);
  const io = { exec: fakeRegistry("0.1.19"), procs: fakeProcesses() };

  await expect(upgrade(root, io, { to: "latest" })).rejects.toThrow("--to takes an exact version");
  expect(io.exec.calls).toHaveLength(0);
});

test("a factory already on the latest says so and still runs up and the typecheck", async () => {
  const port = await fakeService();
  const root = factory(port);
  const io = { exec: fakeRegistry("0.1.18"), procs: fakeProcesses() };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(true);
  expect(lines.join("\n")).toMatch(/^ok {3}bump .* — jigs 0\.1\.18 \(unchanged\)$/m);
  expect(statuses(result).at(-1)).toBe("typecheck:ok");
});

test("a factory linked to a checkout is refused before pnpm runs, naming the published package", async () => {
  const root = factory(1, {
    dependencies: {
      "@jigs/service": "link:/home/me/jigs/packages/service",
      jigs: "link:/home/me/jigs/packages/jigs",
      workflow: "4.8.4",
    },
  });
  const io = { exec: fakeRegistry("0.1.19"), procs: fakeProcesses() };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(false);
  expect(statuses(result)).toEqual(["packages:failed"]);
  expect(result.steps[0]?.detail).toBe(
    "this factory installs jigs from a checkout (@jigs/service: link:/home/me/jigs/packages/service, jigs: link:/home/me/jigs/packages/jigs)",
  );
  expect(result.steps[0]?.repair).toContain("@salimhamed/jigs from GitHub Packages");
  expect(io.exec.calls).toHaveLength(0);
});

test("a published name still linked by path counts as a checkout install", async () => {
  const root = factory(1, {
    dependencies: { "@salimhamed/jigs": "link:../jigs/packages/jigs" },
  });
  const io = { exec: fakeRegistry("0.1.19"), procs: fakeProcesses() };

  const result = await upgrade(root, io);

  expect(statuses(result)).toEqual(["packages:failed"]);
  expect(result.steps[0]?.detail).toContain("@salimhamed/jigs: link:");
});

test("a link: to something other than jigs is not a checkout install", async () => {
  const port = await fakeService();
  const root = factory(port, {
    dependencies: { ...PUBLISHED, "acme-tools": "link:../acme-tools" },
    scripts: { typecheck: "tsc --noEmit" },
  });
  const io = { exec: fakeRegistry("0.1.19"), procs: fakeProcesses() };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(true);
  expect(readManifest(root).dependencies["acme-tools"]).toBe("link:../acme-tools");
});

test("a factory that does not depend on jigs is told so, since pnpm would silently skip it", async () => {
  const root = factory(1, { dependencies: { workflow: "4.8.4" } });
  const io = { exec: fakeRegistry("0.1.19"), procs: fakeProcesses() };

  const result = await upgrade(root, io);

  expect(statuses(result)).toEqual(["packages:failed"]);
  expect(result.steps[0]?.detail).toBe("@salimhamed/jigs not in this factory's package.json");
  expect(io.exec.calls).toHaveLength(0);
});

// The one state an upgrade cannot repair: the factory's imports name a
// package no release has, so pnpm would resolve nothing and the rewrite is
// the operator's.
test("a factory still on the two-package split is sent to the one-time migration", async () => {
  const root = factory(1, {
    dependencies: {
      "@salimhamed/jigs": "0.2.0",
      "@salimhamed/jigs-service": "0.2.0",
    },
  });
  const io = { exec: fakeRegistry("0.3.0"), procs: fakeProcesses() };

  const result = await upgrade(root, io);

  expect(statuses(result)).toEqual(["packages:failed"]);
  expect(result.steps[0]?.detail).toBe(
    "this factory still depends on @salimhamed/jigs-service, which no longer releases",
  );
  expect(result.steps[0]?.repair).toContain(
    "rewrite every import of @salimhamed/jigs-service/X to @salimhamed/jigs/X",
  );
  expect(io.exec.calls).toHaveLength(0);
});

test("outside a factory repo, packages fails with the existing error", async () => {
  const io = { exec: fakeRegistry("0.1.19"), procs: fakeProcesses() };
  const result = await upgrade(tmp, io);
  expect(statuses(result)).toEqual(["packages:failed"]);
  expect(result.steps[0]?.detail).toContain("not inside a factory repo");
});

test("a peer the new release moved fails the bump and names the factory-supplied runtime", async () => {
  const root = factory(1);
  const io = {
    exec: fakeRegistry("0.1.19", (call) =>
      call.args[0] === "update"
        ? execError(
            1,
            "ERR_PNPM_PEER_DEP_ISSUES  Unmet peer dependencies\n. └─┬ @salimhamed/jigs 0.1.19\n   └── ✕ unmet peer workflow@4.9.0: found 4.8.4\n",
          )
        : undefined,
    ),
    procs: fakeProcesses(),
  };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(false);
  expect(statuses(result)).toEqual(["packages:ok", "bump:failed"]);
  expect(result.steps[1]?.detail).toContain("peers on a runtime version");
  expect(result.steps[1]?.repair).toContain("@workflow/world-postgres");
  expect(lines).toContain("     └── ✕ unmet peer workflow@4.9.0: found 4.8.4");
  expect(io.exec.calls).toHaveLength(1);
});

test("a registry that refuses the token points at ~/.npmrc", async () => {
  const root = factory(1);
  const io = {
    exec: fakeRegistry("0.1.19", (call) =>
      call.args[0] === "update"
        ? execError(
            1,
            "ERR_PNPM_FETCH_401  GET https://npm.pkg.github.com/@salimhamed%2Fjigs: Unauthorized - 401\n",
          )
        : undefined,
    ),
    procs: fakeProcesses(),
  };

  const result = await upgrade(root, io);

  expect(statuses(result).at(-1)).toBe("bump:failed");
  expect(result.steps.at(-1)?.repair).toContain("read:packages");
});

test("GitHub Packages answering 404 is a token problem, not a missing release", async () => {
  const root = factory(1);
  const io = {
    exec: fakeRegistry("0.1.19", (call) =>
      call.args[0] === "update"
        ? execError(
            1,
            "ERR_PNPM_FETCH_404  GET https://npm.pkg.github.com/@salimhamed%2Fjigs: Not Found - 404\n",
          )
        : undefined,
    ),
    procs: fakeProcesses(),
  };

  const result = await upgrade(root, io);

  expect(statuses(result).at(-1)).toBe("bump:failed");
  expect(result.steps.at(-1)?.detail).toBe("GitHub Packages refused the request");
  expect(result.steps.at(-1)?.repair).toContain("read:packages");
});

test("an @salimhamed scope not routed to GitHub Packages names the .npmrc line", async () => {
  const root = factory(1);
  const io = {
    exec: fakeRegistry("0.1.19", (call) =>
      call.args[0] === "update"
        ? execError(
            1,
            "ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/@salimhamed%2Fjigs: Not Found - 404\n",
          )
        : undefined,
    ),
    procs: fakeProcesses(),
  };

  const result = await upgrade(root, io);

  expect(statuses(result).at(-1)).toBe("bump:failed");
  expect(result.steps.at(-1)?.repair).toContain("@salimhamed:registry=https://npm.pkg.github.com");
});

test("a version the registry does not have is named with the --to that asked for it", async () => {
  const root = factory(1);
  const io = {
    exec: fakeRegistry("0.1.19", (call) =>
      call.args[0] === "update"
        ? execError(
            1,
            "ERR_PNPM_NO_MATCHING_VERSION  No matching version found for @salimhamed/jigs@9.9.9\n",
          )
        : undefined,
    ),
    procs: fakeProcesses(),
  };

  const result = await upgrade(root, io, { to: "9.9.9" });

  expect(statuses(result).at(-1)).toBe("bump:failed");
  expect(result.steps.at(-1)?.detail).toContain("at 9.9.9");
});

test("pnpm missing from PATH is named at the bump", async () => {
  const root = factory(1);
  const io = {
    exec: fakeRegistry("0.1.19", (call) =>
      call.file === "pnpm" ? execError("ENOENT") : undefined,
    ),
    procs: fakeProcesses(),
  };

  const result = await upgrade(root, io);

  expect(statuses(result)).toEqual(["packages:ok", "bump:failed"]);
  expect(result.steps[1]?.repair).toContain("install pnpm");
});

test("a failing up step ends the upgrade there; no typecheck runs", async () => {
  const root = factory(1);
  const io = {
    exec: fakeRegistry("0.1.19", (call) =>
      call.file === "docker" ? execError(1, "Cannot connect to the Docker daemon\n") : undefined,
    ),
    procs: fakeProcesses(),
  };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(false);
  expect(statuses(result)).toEqual([
    "packages:ok",
    "bump:ok",
    "locate:ok",
    "env:ok",
    "install:ok",
    "generate:ok",
    "compose:failed",
  ]);
  expect(result.up?.ok).toBe(false);
  expect(commands(io).map((c) => c.join(" "))).not.toContain("pnpm run typecheck");
});

test("a red typecheck reports custom factory code errors after refreshing the integration", async () => {
  const port = await fakeService();
  const root = factory(port);
  const io = {
    exec: fakeRegistry("0.1.19", (call) =>
      call.args[0] === "run" && call.args[1] === "typecheck"
        ? execError(
            2,
            "steps/custom.ts(12,3): error TS2305: Module '@salimhamed/jigs/steps' has no exported member 'removedOperation'.\n",
          )
        : undefined,
    ),
    procs: fakeProcesses(),
  };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(false);
  expect(statuses(result).at(-1)).toBe("typecheck:failed");
  expect(result.steps.at(-1)?.repair).toContain("custom factory code");
  expect(lines.join("\n")).toContain("error TS2305");
  expect(lines.at(-2)).toBe(`FAIL typecheck: typecheck failed in ${root}`);
  // The service already runs the new bundle; that is what the red line is for.
  expect(result.up?.ok).toBe(true);
});

test("without a typecheck script the step is skipped and says so", async () => {
  const port = await fakeService();
  const root = factory(port, { dependencies: PUBLISHED });
  const io = { exec: fakeRegistry("0.1.19"), procs: fakeProcesses() };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(true);
  expect(statuses(result).at(-1)).toBe("typecheck:skipped");
  expect(lines).toContain("skip typecheck — no typecheck script in package.json");
  expect(commands(io).map((c) => c.join(" "))).not.toContain("pnpm run typecheck");
});

test("--force and --no-doctor reach up", async () => {
  const port = await fakeService({
    runs: [{ runId: "wrun_01", workflow: "ship", status: "suspended" }],
  });
  const root = factory(port);
  const io = { exec: fakeRegistry("0.1.19"), procs: fakeProcesses() };
  await upgrade(root, io);
  io.exec.bundle = "bundle v2";

  const result = await upgrade(root, io, { force: true, doctor: false });

  expect(result.ok).toBe(true);
  expect(result.up?.service).toBe("restarted");
  expect(statuses(result)).toContain("doctor:skipped");
});

test("a failed integration refresh stops before rebuilding or restarting", async () => {
  const root = factory(59997);
  const io = {
    exec: fakeRegistry("0.1.19", (call) =>
      call.args.join(" ") === "exec jigs generate" ? execError(1, "generation failed") : undefined,
    ),
    procs: fakeProcesses(),
  };
  const result = await upgrade(root, io);
  expect(result.ok).toBe(false);
  expect(statuses(result)).toEqual([
    "packages:ok",
    "bump:ok",
    "locate:ok",
    "env:ok",
    "install:ok",
    "generate:failed",
  ]);
  expect(result.steps.at(-1)?.detail).toBe("could not refresh jigs.ts");
  expect(result.steps.at(-1)?.repair).toBe("run pnpm exec jigs generate in this factory");
  expect(lines.at(-1)).toBe("  → run pnpm exec jigs generate in this factory");
  expect(commands(io)).toEqual([
    ["pnpm", "update", "--latest", "@salimhamed/jigs"],
    ["pnpm", "install"],
    ["pnpm", "exec", "jigs", "generate"],
  ]);
});

test("a missing pnpm during integration refresh names the missing tool", async () => {
  const root = factory(59997);
  const io = {
    exec: fakeRegistry("0.1.19", (call) =>
      call.args.join(" ") === "exec jigs generate" ? execError("ENOENT") : undefined,
    ),
    procs: fakeProcesses(),
  };

  const result = await upgrade(root, io);

  expect(result.ok).toBe(false);
  expect(statuses(result).at(-1)).toBe("generate:failed");
  expect(result.steps.at(-1)?.detail).toBe("pnpm is not on PATH");
  expect(result.steps.at(-1)?.repair).toBe("install pnpm");
  expect(lines.at(-1)).toBe("  → install pnpm");
});
