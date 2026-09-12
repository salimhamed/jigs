import { expect, test } from "vitest";
import { awsCredentialsCheck } from "./aws.ts";

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
    env: {},
    exec: rejecting(new Error("should not run")),
  }).run();
  expect(result).toMatchObject({
    ok: false,
    reason: expect.stringContaining("AWS_PROFILE is not set"),
    repair: "set AWS_PROFILE in the factory repo's .env, then: jigs service restart",
  });
});

test("an empty AWS_PROFILE is treated as unset", async () => {
  const result = await awsCredentialsCheck({
    env: { AWS_PROFILE: "" },
    exec: rejecting(new Error("should not run")),
  }).run();
  expect(result).toMatchObject({
    ok: false,
    reason: expect.stringContaining("AWS_PROFILE is not set"),
  });
});

test("a missing aws executable fails with an install repair", async () => {
  const result = await awsCredentialsCheck({
    env: { AWS_PROFILE: "prod" },
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
    env: { AWS_PROFILE: "prod" },
    exec: rejecting(cliFailure("\nError loading SSO Token: Token for prod does not exist\n\n")),
  }).run();
  expect(result).toMatchObject({
    ok: false,
    reason: expect.stringContaining("prod"),
    repair: "run: aws sso login --profile prod",
  });
  // The last non-empty stderr line, not the whole blank-padded blob.
  expect(result.ok === false && result.reason).toContain("Token for prod does not exist");
});

test("a failure unrelated to SSO points at the profile's own credentials", async () => {
  const result = await awsCredentialsCheck({
    env: { AWS_PROFILE: "typo" },
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
    env: { AWS_PROFILE: "prod" },
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
    repair: "check network access to AWS SSO, or run: aws sso login --profile prod",
  });
  expect(result.ok === false && result.reason).toContain("prod");
});

test("a resolved identity passes with no message", async () => {
  const result = await awsCredentialsCheck({
    env: { AWS_PROFILE: "prod" },
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
    env: { AWS_PROFILE: "prod", PATH: "/usr/bin" },
    exec: async (file, args, options) => {
      spawned = { file, args, env: options.env };
      return { stdout: "{}" };
    },
  }).run();
  expect(spawned.file).toBe("aws");
  expect(spawned.args).toEqual(["sts", "get-caller-identity"]);
  expect(spawned.env).toHaveProperty("AWS_PROFILE", "prod");
});
