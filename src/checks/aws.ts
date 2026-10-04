import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { RESTART_SERVICE, SERVICE_ENV_FILE } from "../providers/credentials.ts";
import { stringEnv } from "../steps/agents/harnesses/env.ts";
import { PROBE_TIMEOUT_MS } from "./catalog.ts";
import type { Check, CheckResult } from "./check.ts";

const execFileAsync = promisify(execFile);

export interface AwsCredentialsDeps {
  exec?: (
    file: string,
    args: string[],
    options: { env: Record<string, string>; timeout: number },
  ) => Promise<{ stdout: string }>;
  env?: NodeJS.ProcessEnv;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

function wasKilled(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const failure = err as { killed?: unknown; signal?: unknown };
  return failure.killed === true || failure.signal != null;
}

function lastStderrLine(err: unknown): string {
  const stderr =
    typeof err === "object" && err !== null && "stderr" in err
      ? String((err as { stderr?: unknown }).stderr ?? "")
      : "";
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.at(-1) ?? String(err);
}

async function usesSso(
  exec: NonNullable<AwsCredentialsDeps["exec"]>,
  env: Record<string, string>,
  profile: string,
): Promise<boolean> {
  const set = await Promise.all(
    ["sso_session", "sso_start_url"].map((key) =>
      exec("aws", ["configure", "get", key, "--profile", profile], {
        env,
        timeout: PROBE_TIMEOUT_MS,
      }).then(
        ({ stdout }) => stdout.trim() !== "",
        () => false,
      ),
    ),
  );
  return set.includes(true);
}

// The CLI keeps an SSO profile's role credentials under ~/.aws/cli/cache and
// serves them for hours after the SSO login itself has expired. A HOME without
// that cache, sharing the real SSO login, makes the CLI prove the login still
// mints credentials. Botocore refreshes the login there as it would anywhere.
async function withoutCachedRoleCredentials<T>(
  env: Record<string, string>,
  run: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const home = env.HOME ?? os.homedir();
  const isolated = await mkdtemp(path.join(os.tmpdir(), "jigs-aws-"));
  try {
    await mkdir(path.join(isolated, ".aws"));
    await symlink(path.join(home, ".aws", "sso"), path.join(isolated, ".aws", "sso"));
    return await run({
      ...env,
      HOME: isolated,
      AWS_CONFIG_FILE: env.AWS_CONFIG_FILE ?? path.join(home, ".aws", "config"),
      AWS_SHARED_CREDENTIALS_FILE:
        env.AWS_SHARED_CREDENTIALS_FILE ?? path.join(home, ".aws", "credentials"),
    });
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
}

// The whole credential chain is the CLI's business, so the probe asks it
// rather than reading ~/.aws itself: an SSO cache miss and a bad key look
// identical from the config file and different from get-caller-identity.
export function awsCredentialsCheck(deps: AwsCredentialsDeps = {}): Check {
  const exec = deps.exec ?? execFileAsync;
  const env = deps.env ?? process.env;
  const callerIdentity = (probeEnv: Record<string, string>) =>
    exec("aws", ["sts", "get-caller-identity"], { env: probeEnv, timeout: PROBE_TIMEOUT_MS });
  return {
    id: "aws.credentials",
    label: "AWS credentials",
    run: async (): Promise<CheckResult> => {
      const profile = env.AWS_PROFILE;
      if (profile === undefined || profile === "") {
        return {
          ok: false,
          reason: "AWS_PROFILE is not set in the service's environment",
          repair: `set AWS_PROFILE in ${SERVICE_ENV_FILE}, then: \`${RESTART_SERVICE}\``,
        };
      }

      const probeEnv = stringEnv(env);
      const sso = await usesSso(exec, probeEnv, profile);
      try {
        await (sso
          ? withoutCachedRoleCredentials(probeEnv, callerIdentity)
          : callerIdentity(probeEnv));
      } catch (err) {
        if (isEnoent(err)) {
          return {
            ok: false,
            reason: "the aws executable is not on PATH",
            repair: "install the AWS CLI v2",
          };
        }
        // A killed probe carries no stderr to quote, and the generic
        // credentials repair would send the operator to a config file that is
        // fine — the network to AWS is what did not answer.
        if (wasKilled(err)) {
          return {
            ok: false,
            reason: `\`aws sts get-caller-identity\` did not answer within ${PROBE_TIMEOUT_MS / 1000}s under profile ${profile}`,
            repair: `check network access to AWS SSO, or log in again: \`aws sso login --profile ${profile}\``,
          };
        }
        const detail = lastStderrLine(err);
        const expired = /sso|token/i.test(detail);
        const probe = sso
          ? "`aws sts get-caller-identity` failed without its cached role credentials"
          : "`aws sts get-caller-identity` failed";
        return {
          ok: false,
          reason: `AWS_PROFILE is ${profile} but ${probe}: ${detail}`,
          repair: expired
            ? `run: \`aws sso login --profile ${profile}\``
            : `check the ${profile} profile's credentials in ~/.aws/config`,
        };
      }
      return { ok: true };
    },
  };
}
