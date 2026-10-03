import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FatalError } from "workflow";
import { AGENT_TOKEN_MIN_LIFETIME_MS, type GithubAuth } from "../../../providers/github-auth.ts";
import { git, makeTmpDir, removeTmpDir } from "../../../test-fixtures.ts";
import { githubMcp } from "../../../workflow/agents/github-mcp.ts";
import { harnesses } from "../../../workflow/agents/harness-config.ts";
import { type AgentGithubDeps, agentGithubEnv } from "./github-access.ts";

const APP = {
  mode: "app",
  appId: 1,
  installationId: 2,
  privateKeyPath: "/key.pem",
  operator: "salimhamed",
} as const;
const TOKEN = "ghs_agent_token";

let tmp: string;
beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => removeTmpDir(tmp));

function deps(identity: GithubAuth["identity"] = APP, remote = "git@github.com:acme/api.git") {
  const bearer = vi.fn(async () => TOKEN);
  const auth = vi.fn((_owner: string): GithubAuth => ({ identity, bearer }));
  const fake: AgentGithubDeps = {
    remoteUrl: async () => remote,
    auth,
    bot: async () => ({ login: "jigs-dev[bot]", id: 4242 }),
  };
  return { fake, auth, bearer };
}

test("an agent whose harness does not opt in gets nothing", async () => {
  const { fake, auth } = deps();
  const env = await agentGithubEnv({ harness: harnesses.codex({ model: "m" }), cwd: tmp }, fake);
  expect(env).toEqual({});
  expect(auth).not.toHaveBeenCalled();
});

test("an opted-in agent gets the token, HTTPS pushes and the bot as author", async () => {
  const { fake, auth } = deps();
  const env = await agentGithubEnv(
    { harness: harnesses.codex({ model: "m", github: true }), cwd: tmp },
    fake,
  );
  expect(auth).toHaveBeenCalledWith("acme");
  expect(env).toMatchObject({
    GH_TOKEN: TOKEN,
    GIT_AUTHOR_NAME: "jigs-dev[bot]",
    GIT_AUTHOR_EMAIL: "4242+jigs-dev[bot]@users.noreply.github.com",
  });
  expect(env).not.toHaveProperty("GIT_COMMITTER_NAME");
  expect(env).not.toHaveProperty("GIT_COMMITTER_EMAIL");
});

test("the token has close to a full hour left when the step starts", async () => {
  const { fake, bearer } = deps();
  await agentGithubEnv({ harness: harnesses.claude({ model: "m", github: true }), cwd: tmp }, fake);
  expect(bearer).toHaveBeenCalledWith(AGENT_TOKEN_MIN_LIFETIME_MS);
  expect(AGENT_TOKEN_MIN_LIFETIME_MS).toBeGreaterThanOrEqual(55 * 60_000);
});

test("git rewrites SSH remotes to HTTPS and sends the token, from the environment alone", async () => {
  const { fake } = deps();
  const env = await agentGithubEnv(
    { harness: harnesses.claude({ model: "m", github: true }), cwd: tmp },
    fake,
  );
  git(tmp, "init", "-q");
  const run = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: tmp,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", ...env },
    }).trim();
  for (const remote of ["git@github.com:acme/api.git", "ssh://git@github.com/acme/api.git"])
    expect(run("ls-remote", "--get-url", remote)).toBe("https://github.com/acme/api.git");
  const header = run("config", "--get", "http.https://github.com/.extraheader");
  const basic = header.replace("Authorization: Basic ", "");
  expect(Buffer.from(basic, "base64").toString()).toBe(`x-access-token:${TOKEN}`);
  // Nothing was written into the repository.
  expect(git(tmp, "config", "--local", "--list")).not.toContain("extraheader");
});

test("github with an owner acts on that account, with no checkout needed", async () => {
  const { fake, auth } = deps();
  const remoteUrl = vi.fn();
  await agentGithubEnv(
    { harness: harnesses.claude({ model: "m", github: { owner: "Other" } }), cwd: tmp },
    { ...fake, remoteUrl },
  );
  expect(auth).toHaveBeenCalledWith("Other");
  expect(remoteUrl).not.toHaveBeenCalled();
});

test("github: true outside a github.com checkout asks for the owner", async () => {
  const { fake } = deps(APP, "https://gitlab.com/acme/api.git");
  await expect(
    agentGithubEnv({ harness: harnesses.claude({ model: "m", github: true }), cwd: tmp }, fake),
  ).rejects.toThrow("github: { owner }");
});

test("with a personal access token, an opted-in agent fails before it starts, without a retry", async () => {
  const { fake, bearer } = deps({ mode: "pat" });
  const failure = await agentGithubEnv(
    { harness: harnesses.claude({ model: "m", github: true }), cwd: tmp },
    fake,
  ).catch((err: unknown) => err);
  expect(failure).toMatchObject({
    message: expect.stringContaining("needs a GitHub App identity"),
  });
  expect(FatalError.is(failure)).toBe(true);
  expect(bearer).not.toHaveBeenCalled();
});

test("a server reading the agent's token on a harness without github fails the step", async () => {
  const { fake } = deps();
  const harness = { kind: "claude", model: "m", mcpServers: { github: githubMcp() } } as const;
  await expect(agentGithubEnv({ harness, cwd: tmp }, fake)).rejects.toThrow(
    "MCP server 'github' reads GH_TOKEN",
  );
});
