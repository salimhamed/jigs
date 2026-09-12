import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import tsdownConfig from "../tsdown.config.ts";

// A factory builds against this package's compiled dist/, and the Workflow SDK
// derives durable step ids from the package name, version and export subpath a
// directive-bearing file is reached through. So this package carries no
// directives at all: the "use step" wrappers live in the factory, ids are
// factory-local paths, and no version of anything is a memoization key. Every
// assertion below guards a failure that is otherwise silent — no error, just
// wrong ids, in someone else's repo.

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const templatesDir = path.join(packageDir, "templates");
const pkg = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
const exportTargets: string[] = Object.values(pkg.exports).flatMap((entry) =>
  typeof entry === "string" ? [entry] : Object.values(entry as object),
);

const directive = /^\s*["']use (step|workflow)["']/m;
const optionalPeers = new Set(
  Object.entries<{ optional?: boolean }>(pkg.peerDependenciesMeta ?? {})
    .filter(([, meta]) => meta.optional === true)
    .map(([name]) => name),
);

async function templateFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory() ? templateFiles(file) : [file];
    }),
  );
  return files.flat().filter((file) => file.endsWith(".tmpl"));
}

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(path.join(packageDir, dir), {
    withFileTypes: true,
  });
  const files = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? sourceFiles(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`],
    ),
  );
  return files.flat().filter((file) => file.endsWith(".ts"));
}

test("no compiled source carries a workflow directive — the factory writes its own", async () => {
  // The wrappers live in the factory repo, which is what keeps this package's
  // version out of every memoization key. A directive sneaking back in here
  // compiles clean and resurrects a version-bearing id, so this is the guard
  // that has to hold. src/ is what this package compiles; the directives in
  // templates/ are .tmpl files a factory compiles, never this one.
  const directed: string[] = [];
  for (const file of await sourceFiles("src")) {
    const source = await readFile(path.join(packageDir, file), "utf8");
    if (directive.test(source)) directed.push(file);
  }
  expect(directed).toEqual([]);
});

test("every subpath the scaffold reaches is in the exports map", async () => {
  // A factory resolves this package through the exports map alone, so a
  // subpath dropped here is a wrapper that cannot resolve in every factory
  // that already has one. The templates are where every factory's code starts.
  const reached = new Set<string>();
  for (const file of await templateFiles(templatesDir)) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/"@salimhamed\/jigs(\/[^"]*)?"/g)) {
      reached.add(`.${match[1] ?? ""}`);
    }
  }
  expect(reached.size).toBeGreaterThan(1);
  for (const subpath of reached) {
    expect(Object.keys(pkg.exports), subpath).toContain(subpath);
  }
});

test("every exports target is a dist file tsdown emits from a source file that exists", () => {
  // A factory resolves this package through dist/ alone, so a target has to be
  // something the build writes. Checked against the build's entry list rather
  // than a built dist/, so this holds before the first build too.
  const entries = (tsdownConfig as { entry: Record<string, string> }).entry;
  for (const target of exportTargets) {
    const match = /^\.\/dist\/(.+)\.(js|d\.ts)$/.exec(target);
    expect(match, target).not.toBeNull();
    const source = entries[match?.[1] ?? ""];
    expect(source, target).toBeDefined();
    expect(existsSync(path.join(packageDir, source ?? ""))).toBe(true);
  }
});

test("every tsdown entry is reachable through the exports map or the bin", () => {
  // The inverse: an entry with no subpath is compiled output nothing can
  // import, which is a subpath someone forgot to export. The bin is the one
  // entry reached by path instead.
  const entries = (tsdownConfig as { entry: Record<string, string> }).entry;
  const reachable = [...exportTargets, ...Object.values<string>(pkg.bin)];
  for (const key of Object.keys(entries)) {
    expect(reachable, key).toContain(`./dist/${key}.js`);
  }
});

// What a factory must install itself, so it is a peer here rather than a
// dependency: the SDK its compiled workflows register into, the World the SDK
// loads by name from the factory's node_modules, the dashboard the plugin
// resolves from cwd, and the zod its own input schemas are built with. As a
// dependency, pnpm resolves a range to the newest version, so a factory that
// pins an older one gets a second copy — and a second copy is silent: step
// ids nothing registers, schema types that do not unify.
const FACTORY_SUPPLIED = ["@workflow/web", "@workflow/world-postgres", "workflow", "zod"];

test("the runtime a factory supplies is a peer here, and still a devDependency", () => {
  // They stay in devDependencies so this repo's own tests and build still
  // resolve them. Everything else this package imports is a plain dependency:
  // an install resolves it from this package's own node_modules, so the
  // factory never has to list it.
  const peers: Record<string, string> = pkg.peerDependencies;
  expect(Object.keys(peers).filter((name) => !optionalPeers.has(name))).toEqual(FACTORY_SUPPLIED);
  for (const [name, range] of Object.entries(peers)) {
    expect(pkg.devDependencies[name], name).toBe(range);
    expect(pkg.dependencies[name], name).toBeUndefined();
  }
});

test("the factory template pins the same versions this package peers on", async () => {
  // The template is what a factory installs; a peer bumped here and not there
  // fails the factory's install under strictPeerDependencies, or without it
  // gives the factory two copies of the SDK and a manifest full of step ids
  // nothing registers.
  const template = JSON.parse(
    (await readFile(path.join(templatesDir, "package.json.tmpl"), "utf8")).replaceAll(
      "{{JIGS_VERSION}}",
      pkg.version,
    ),
  );
  for (const [name, range] of Object.entries<string>(pkg.peerDependencies)) {
    // nitro is the one optional peer: it is only here so the emitted
    // declarations reference its types instead of inlining them, and a factory
    // holds it as a devDependency, the way this package does.
    const section = optionalPeers.has(name) ? "devDependencies" : "dependencies";
    expect(template[section][name], name).toBe(range);
  }
  for (const name of ["croner", "hono", "postgres"]) {
    expect(template.dependencies[name], name).toBeUndefined();
  }
  // Pinned to the exact version of the CLI that scaffolded it, never a range
  // or a link: the compiler and the runtime have to be one install.
  expect(template.dependencies["@salimhamed/jigs"]).toBe(pkg.version);
});

// The two barrels are the whole public code surface now: nine subpaths, of
// which four are reachable from the scaffold — `.`, ./blocks, ./steps and
// ./nitro — so the exports-map test above covers under half of them, and the
// exports-target test checks only that an entry's source file exists, never
// what it exports. Value names only: this test reads them back through a
// runtime import, which cannot see a type at all. The type surface of both
// barrels is guarded next door, by tsc, in barrels.types.test.ts.
const BARREL_EXPORTS: Record<string, string[]> = {
  "blocks/index.ts": [
    "agent",
    "agentOrHalt",
    "bindJigs",
    "answerReview",
    "answerReviewPrompt",
    "ask",
    "attend",
    "buildAgentWire",
    "buildAskWire",
    "ClaimConflictError",
    "claimTicket",
    "classifyPrState",
    "claude",
    "codeReviewPrompt",
    "codeReviewVerdict",
    "codex",
    "commitWork",
    "commitWorkPrompt",
    "describePullRequest",
    "finished",
    "fixCi",
    "fixCiFreshPrompt",
    "fixCiPrompt",
    "haltForHuman",
    "haltOption",
    "haltQuestion",
    "implementPrompt",
    "implementUntilCodeReviewApproves",
    "interpolate",
    "JitCheckError",
    "listen",
    "NEEDS_HUMAN_TOKEN_PREFIX",
    "needsHumanToken",
    "parseOutput",
    "postReviewAnswers",
    "PR_TOKEN_PREFIX",
    "pullRequestDescription",
    "prToken",
    "pullRequestGate",
    "rebuildContextPrompt",
    "renderChecks",
    "renderSnapshot",
    "resumeOrRebuild",
    "reviewTicket",
    "threadAnswers",
    "TICKET_TOKEN_PREFIX",
    "ticketReviewPrompt",
    "ticketReviewVerdict",
    "ticketToken",
    "tokenFromGithubPayload",
    "tokenFromLinearPayload",
    "toSnapshot",
    "unreachable",
    "unwrapAgentStep",
  ],
  "steps/index.ts": [
    "readBranchState",
    "checkForHumanReply",
    "commentOnPullRequest",
    "createComment",
    "createIssueInProject",
    "dashboardRunUrl",
    "fetchPullRequestState",
    "fetchTicketSnapshot",
    "findIssueInProject",
    "openPullRequest",
    "postNeedsHumanComment",
    "postTicketNote",
    "provisionWorktree",
    "pushBranch",
    "readWorktreeDiff",
    "realDeps",
    "renderNeedsHumanComment",
    "renderProceedingNote",
    "replyToPullRequestReviewThread",
    "resolveRepository",
    "runAgent",
    "askModel",
    "squashMergePullRequest",
    "removeMergedRunWorktrees",
  ],
};

test("every barrel exports exactly the values its subpath promises", async () => {
  for (const [file, names] of Object.entries(BARREL_EXPORTS)) {
    const module = await import(path.join(packageDir, "src", file));
    expect(Object.keys(module).sort(), file).toEqual(names.sort());
  }
});
