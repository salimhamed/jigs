import { existsSync } from "node:fs";
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
