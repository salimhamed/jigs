import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { JigsError } from "../../errors.ts";
import { type ExecFile, execOrExplain, execOutput } from "../exec.ts";

/**
 * Runs `docker compose <args>` in the factory root, streaming its output as it
 * prints: the first `up` pulls the Postgres image, minutes of silence otherwise.
 */
export async function dockerCompose(
  execFile: ExecFile,
  factoryRoot: string,
  args: string[],
  out: (line: string) => void,
): Promise<void> {
  if (!existsSync(path.join(factoryRoot, "docker-compose.yml"))) {
    throw new JigsError(
      `no docker-compose.yml in ${factoryRoot}`,
      "scaffold one: pnpm exec jigs init",
    );
  }
  await execOrExplain(
    execFile,
    "docker",
    ["compose", ...args],
    { cwd: factoryRoot, onLine: (line) => out(`  ${line}`) },
    out,
    {
      missing: new JigsError("docker is not on PATH", "install docker and start its daemon"),
      failed: (err) =>
        /Cannot connect to the Docker daemon/i.test(execOutput(err))
          ? new JigsError("the docker daemon is not running", "start docker")
          : new JigsError(
              `docker compose ${args[0]} failed in ${factoryRoot}`,
              "the output above is docker compose's",
            ),
    },
  );
}

/**
 * The name the operator knows this factory by: its compose project, which
 * `jigs init` sets to the directory it scaffolded.
 */
export function factoryName(factoryRoot: string): string {
  const composeFile = path.join(factoryRoot, "docker-compose.yml");
  const project = existsSync(composeFile)
    ? readFileSync(composeFile, "utf8").match(/^name:\s*["']?([^"'\s#]+)/m)?.[1]
    : undefined;
  return project ?? path.basename(factoryRoot);
}

export interface PostgresNames {
  container?: string;
  volume?: string;
}

/**
 * The Postgres container and volume as docker compose names them, each left
 * out when compose cannot say: a guessed name would send the operator after a
 * container that does not exist.
 */
export async function postgresNames(
  execFile: ExecFile,
  factoryRoot: string,
): Promise<PostgresNames> {
  const container = await composeLookup(
    execFile,
    factoryRoot,
    ["ps", "-a", "--format", "json"],
    (stdout) => {
      // Older compose prints one array, newer one object per line.
      const trimmed = stdout.trim();
      const entries = (
        trimmed.startsWith("[")
          ? JSON.parse(trimmed)
          : trimmed
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line))
      ) as Array<{ Name?: string; Service?: string }>;
      return (entries.find((entry) => entry.Service === "postgres") ?? entries[0])?.Name;
    },
  );
  const volume = await composeLookup(
    execFile,
    factoryRoot,
    ["config", "--format", "json"],
    (stdout) => {
      const config = JSON.parse(stdout) as { volumes?: Record<string, { name?: string }> };
      return Object.values(config.volumes ?? {})[0]?.name;
    },
  );
  return { container, volume };
}

async function composeLookup(
  execFile: ExecFile,
  factoryRoot: string,
  args: string[],
  pick: (stdout: string) => string | undefined,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFile("docker", ["compose", ...args], { cwd: factoryRoot });
    const name = pick(stdout);
    return typeof name === "string" && name !== "" ? name : undefined;
  } catch {
    return undefined;
  }
}
