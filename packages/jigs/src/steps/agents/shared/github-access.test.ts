import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FatalError } from "workflow";
import { AGENT_TOKEN_MIN_LIFETIME_MS } from "../../../providers/credentials.ts";
import type { GithubAuth } from "../../../providers/github-auth.ts";
import { git, makeTmpDir, removeTmpDir } from "../../../test-fixtures.ts";
import { type Harness, harnesses } from "../../../workflow/agents/harness-config.ts";
import { type AgentGithubDeps, agentGithubEnv } from "./github-access.ts";

const TOKEN = "ghs_agent_token";

let tmp: string;
beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => removeTmpDir(tmp));

function deps(
  remote = "git@github.com:acme/api.git",
  bot: GithubAuth["bot"] = async () => ({ login: "jigs-dev[bot]", id: 4242 }),
) {
  const bearer = vi.fn(async () => TOKEN);
  const auth = vi.fn((_owner: string): GithubAuth => ({ bearer, invalidate: () => {}, bot }));
  const fake: AgentGithubDeps = { remoteUrl: async () => remote, auth };
  return { fake, auth, bearer };
}

const optedIn = harnesses.claude({ model: "m", github: true });
const envFor = (harness: Harness, fake: AgentGithubDeps, base: Record<string, string> = {}) =>
  agentGithubEnv({ harness, cwd: tmp }, base, fake);

// git run under nothing but the agent's environment.
function gitUnder(env: Record<string, string>) {
  git(tmp, "init", "-q");
  return (...args: string[]) => {
    try {
      return execFileSync("git", args, {
        cwd: tmp,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", ...env },
      }).trim();
    } catch {
      return null;
    }
  };
}

test("an agent whose harness does not opt in gets nothing", async () => {
  const { fake, auth } = deps();
  expect(await envFor(harnesses.codex({ model: "m" }), fake)).toEqual({});
  expect(auth).not.toHaveBeenCalled();
});

test("an opted-in agent gets the token and the bot as author", async () => {
  const { fake, auth } = deps();
  const env = await envFor(harnesses.codex({ model: "m", github: true }), fake);
  expect(auth).toHaveBeenCalledWith("acme");
  expect(env).toMatchObject({
    GH_TOKEN: TOKEN,
    GIT_AUTHOR_NAME: "jigs-dev[bot]",
    GIT_AUTHOR_EMAIL: "4242+jigs-dev[bot]@users.noreply.github.com",
  });
});

test("the committer, user and signing settings stay the operator's own", async () => {
  const env = await envFor(optedIn, deps().fake);
  expect(Object.keys(env).filter((name) => name.startsWith("GIT_COMMITTER_"))).toEqual([]);
  const settings = Object.entries(env)
    .filter(([name]) => name.startsWith("GIT_CONFIG_KEY_"))
    .map(([, key]) => key);
  expect(settings.filter((key) => /^(user|gpg|commit|tag)\./.test(key))).toEqual([]);
});

test("the token has close to a full hour left when the step starts", async () => {
  const { fake, bearer } = deps();
  await envFor(optedIn, fake);
  expect(bearer).toHaveBeenCalledWith(AGENT_TOKEN_MIN_LIFETIME_MS.github);
  expect(AGENT_TOKEN_MIN_LIFETIME_MS.github).toBeGreaterThanOrEqual(55 * 60_000);
});

test("git reaches the owner's repositories over HTTPS with the token, from the environment alone", async () => {
  const run = gitUnder(await envFor(optedIn, deps().fake));
  for (const remote of ["git@github.com:acme/api.git", "ssh://git@github.com/acme/api.git"])
    expect(run("ls-remote", "--get-url", remote)).toBe("https://github.com/acme/api.git");
  const header = run("config", "--get-urlmatch", "http.extraheader", "https://github.com/acme/api");
  const basic = header?.replace("Authorization: Basic ", "") ?? "";
  expect(Buffer.from(basic, "base64").toString()).toBe(`x-access-token:${TOKEN}`);
  // Nothing was written into the repository.
  expect(git(tmp, "config", "--local", "--list")).not.toContain("extraheader");
});

test("another owner's repositories keep their transport and never see the token", async () => {
  const run = gitUnder(await envFor(optedIn, deps().fake));
  expect(run("ls-remote", "--get-url", "git@github.com:other/dep.git")).toBe(
    "git@github.com:other/dep.git",
  );
  expect(run("ls-remote", "--get-url", "git@github.com:acme-labs/dep.git")).toBe(
    "git@github.com:acme-labs/dep.git",
  );
  expect(
    run("config", "--get-urlmatch", "http.extraheader", "https://github.com/other/dep"),
  ).toBeNull();
});

test("git settings already in the agent's environment keep their place", async () => {
  const base = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.abbrev",
    GIT_CONFIG_VALUE_0: "12",
  };
  const env = await envFor(optedIn, deps().fake, base);
  expect(env.GIT_CONFIG_COUNT).toBe("4");
  expect(env).not.toHaveProperty("GIT_CONFIG_KEY_0");
  const run = gitUnder({ ...base, ...env });
  expect(run("config", "--get", "core.abbrev")).toBe("12");
  expect(run("ls-remote", "--get-url", "git@github.com:acme/api.git")).toBe(
    "https://github.com/acme/api.git",
  );
});

test("github with an owner acts on that account, with no checkout needed", async () => {
  const { fake, auth } = deps();
  const remoteUrl = vi.fn();
  await envFor(harnesses.claude({ model: "m", github: { owner: "Other" } }), {
    ...fake,
    remoteUrl,
  });
  expect(auth).toHaveBeenCalledWith("Other");
  expect(remoteUrl).not.toHaveBeenCalled();
});

test("github: true outside a github.com checkout asks for the owner", async () => {
  const { fake } = deps("https://gitlab.com/acme/api.git");
  const failure = await envFor(optedIn, fake).catch((err: unknown) => err);
  expect(failure).toMatchObject({ message: expect.stringContaining("github: { owner }") });
  expect(FatalError.is(failure)).toBe(true);
});

test("a failure after the token is minted never names it", async () => {
  const { fake } = deps(undefined, async () => {
    throw new Error("the hub answered 502");
  });
  const failure = await envFor(optedIn, fake).catch((err: unknown) => err);
  expect(String(failure)).toContain("502");
  expect(String(failure)).not.toContain(TOKEN);
});
