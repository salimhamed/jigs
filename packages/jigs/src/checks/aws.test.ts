import { existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { type AwsCredentialsDeps, awsCredentialsCheck } from "./aws.ts";

// Verbatim shapes of what promisify(execFile) rejects with: ENOENT for a
// missing binary, exit code plus stderr for a CLI that ran and refused.
function spawnFailure(): Error {
  return Object.assign(new Error("spawn aws ENOENT"), { code: "ENOENT" });
}

function cliFailure(stderr: string): Error {
  return Object.assign(new Error("Command failed: aws sts get-caller-identity"), {
    code: 255,
    stderr,
  });
}

const rejecting = (err: Error) => async () => {
  throw err;
};

test("an unset AWS_PROFILE fails naming the env file and the restart", async () => {
  const result = await awsCredentialsCheck({
    factoryEnv: () => undefined,
    exec: rejecting(new Error("should not run")),
  }).run();
  expect(result).toMatchObject({
    ok: false,
    reason: expect.stringContaining("AWS_PROFILE is not set"),
    repair:
      "set AWS_PROFILE in the factory's environment, then: `pnpm exec jigs up --restart-service`",
  });
});

test("a missing aws executable fails with an install repair", async () => {
  const result = await awsCredentialsCheck({
    factoryEnv: () => "prod",
    exec: rejecting(spawnFailure()),
  }).run();
  expect(result).toMatchObject({
    ok: false,
    reason: expect.stringContaining("aws executable"),
    repair: "install the AWS CLI v2",
  });
});

test("an expired SSO session fails with the login for that profile", async () => {
  const result = await awsCredentialsCheck({
    factoryEnv: () => "prod",
    exec: rejecting(cliFailure("\nError loading SSO Token: Token for prod does not exist\n\n")),
  }).run();
  expect(result).toMatchObject({
    ok: false,
    reason: expect.stringContaining("prod"),
    repair: "run: `aws sso login --profile prod`",
  });
  // The last non-empty stderr line, not the whole blank-padded blob.
  expect(result.ok === false && result.reason).toContain("Token for prod does not exist");
});

test("a failure unrelated to SSO points at the profile's own credentials", async () => {
  const result = await awsCredentialsCheck({
    factoryEnv: () => "typo",
    exec: rejecting(cliFailure("The config profile (typo) could not be found")),
  }).run();
  expect(result).toMatchObject({
    ok: false,
    reason: expect.stringContaining("could not be found"),
    repair: "check the typo profile's credentials in ~/.aws/config",
  });
});

test("a probe killed by the timeout blames the network, not the config file", async () => {
  const result = await awsCredentialsCheck({
    factoryEnv: () => "prod",
    exec: rejecting(
      Object.assign(new Error("Command failed: aws sts get-caller-identity"), {
        code: null,
        killed: true,
        signal: "SIGTERM",
        stderr: "",
      }),
    ),
  }).run();
  expect(result).toMatchObject({
    ok: false,
    reason: expect.stringContaining("did not answer within 12s"),
    repair: "check network access to AWS SSO, or log in again: `aws sso login --profile prod`",
  });
  expect(result.ok === false && result.reason).toContain("prod");
});

test("a resolved identity passes with no message", async () => {
  const result = await awsCredentialsCheck({
    factoryEnv: () => "prod",
    exec: async () => ({
      stdout: JSON.stringify({
        UserId: "AROA:dev",
        Account: "123456789012",
        Arn: "arn:aws:sts::123456789012:assumed-role/read-only/dev",
      }),
    }),
  }).run();
  expect(result).toEqual({ ok: true });
});

test("the probe runs the CLI by argv under the profile's env, never a shell", async () => {
  let spawned: { file: string; args: string[]; env: Record<string, string> } = {
    file: "",
    args: [],
    env: {},
  };
  await awsCredentialsCheck({
    env: { PATH: "/usr/bin" },
    factoryEnv: () => "prod",
    exec: async (file, args, options) => {
      if (args[0] === "configure") throw cliFailure("");
      spawned = { file, args, env: options.env };
      return { stdout: "{}" };
    },
  }).run();
  expect(spawned.file).toBe("aws");
  expect(spawned.args).toEqual(["sts", "get-caller-identity"]);
  expect(spawned.env).toEqual({ AWS_PROFILE: "prod", PATH: "/usr/bin" });
});

// `aws configure get` exits 1 for a key the profile does not set.
function fakeAws(
  profileConfig: Record<string, string>,
  sts: (env: Record<string, string>) => void,
): AwsCredentialsDeps["exec"] {
  return async (_file, args, options) => {
    if (args[0] === "configure") {
      const value = profileConfig[args[2] ?? ""];
      if (value === undefined) throw cliFailure("");
      return { stdout: `${value}\n` };
    }
    sts(options.env);
    return { stdout: "{}" };
  };
}

describe("an SSO profile", () => {
  let home: string;
  beforeEach(() => {
    home = makeTmpDir();
    mkdirSync(path.join(home, ".aws", "sso", "cache"), { recursive: true });
  });
  afterEach(() => removeTmpDir(home));

  test.each([
    ["an sso-session", { sso_session: "corp" }],
    ["a legacy start URL", { sso_start_url: "https://corp.awsapps.com/start" }],
  ])("with %s resolves credentials past the cached role credentials", async (_label, config) => {
    let seen: Record<string, string> = {};
    const result = await awsCredentialsCheck({
      env: { HOME: home },
      factoryEnv: () => "prod",
      exec: fakeAws(config, (env) => {
        seen = env;
        // The CLI's role-credential cache lives under HOME; the SSO login does not move.
        expect(realpathSync(path.join(env.HOME ?? "", ".aws", "sso"))).toBe(
          realpathSync(path.join(home, ".aws", "sso")),
        );
      }),
    }).run();
    expect(result).toEqual({ ok: true });
    expect(seen.HOME).not.toBe(home);
    expect(seen).toMatchObject({
      AWS_PROFILE: "prod",
      AWS_CONFIG_FILE: path.join(home, ".aws", "config"),
      AWS_SHARED_CREDENTIALS_FILE: path.join(home, ".aws", "credentials"),
    });
    expect(existsSync(seen.HOME ?? "")).toBe(false);
  });

  test("keeps config files the environment already points at", async () => {
    let seen: Record<string, string> = {};
    await awsCredentialsCheck({
      factoryEnv: () => "prod",
      env: {
        HOME: home,
        AWS_CONFIG_FILE: "/etc/aws/config",
        AWS_SHARED_CREDENTIALS_FILE: "/etc/aws/credentials",
      },
      exec: fakeAws({ sso_session: "corp" }, (env) => {
        seen = env;
      }),
    }).run();
    expect(seen).toMatchObject({
      AWS_CONFIG_FILE: "/etc/aws/config",
      AWS_SHARED_CREDENTIALS_FILE: "/etc/aws/credentials",
    });
  });

  test("whose SSO login expired fails while cached role credentials would still pass", async () => {
    const result = await awsCredentialsCheck({
      env: { HOME: home },
      factoryEnv: () => "prod",
      exec: fakeAws({ sso_session: "corp" }, () => {
        throw cliFailure(
          "\nError when retrieving token from sso: Token has expired and refresh failed\n",
        );
      }),
    }).run();
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Token has expired and refresh failed"),
      repair: "run: `aws sso login --profile prod`",
    });
    expect(result.ok === false && result.reason).toContain("cached role credentials");
  });
});
