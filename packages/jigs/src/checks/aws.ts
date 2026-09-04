import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stringEnv } from "../harnesses/env.ts";
import { type Check, type CheckResult, PROBE_TIMEOUT_MS } from "./catalog.ts";
import { RESTART_SERVICE, SERVICE_ENV_FILE } from "./core.ts";

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

// The whole credential chain is the CLI's business, so the probe asks it
// rather than reading ~/.aws itself: an SSO cache miss and a bad key look
// identical from the config file and different from get-caller-identity.
export function awsCredentialsCheck(deps: AwsCredentialsDeps = {}): Check {
  const exec = deps.exec ?? execFileAsync;
  const env = deps.env ?? process.env;
  return {
    id: "aws.credentials",
    label: "AWS credentials",
    run: async (): Promise<CheckResult> => {
      const profile = env.AWS_PROFILE;
      if (profile === undefined || profile === "") {
        return {
          ok: false,
          reason: "AWS_PROFILE is not set in the service's environment",
          repair: `set AWS_PROFILE in ${SERVICE_ENV_FILE}, then: ${RESTART_SERVICE}`,
        };
      }

      try {
        await exec("aws", ["sts", "get-caller-identity", "--output", "json"], {
          env: stringEnv(env),
          timeout: PROBE_TIMEOUT_MS,
        });
      } catch (err) {
        if (isEnoent(err)) {
          return {
            ok: false,
            reason: "the aws executable is not on PATH",
            repair: "install the AWS CLI v2",
          };
        }
        const detail = lastStderrLine(err);
        const expired = /sso|token/i.test(detail);
        return {
          ok: false,
          reason: `AWS_PROFILE is ${profile} but \`aws sts get-caller-identity\` failed: ${detail}`,
          repair: expired
            ? `run: aws sso login --profile ${profile}`
            : `check the ${profile} profile's credentials in ~/.aws/config`,
        };
      }
      return { ok: true };
    },
  };
}
