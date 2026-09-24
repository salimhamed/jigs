import { locateFactoryRoot } from "../../config/factory-root.ts";
import { type ExecFile, nodeExecFile } from "../exec.ts";
import { dockerCompose, factoryName, postgresNames } from "./compose.ts";
import { type ServiceProcesses, stopService } from "./service-lifecycle.ts";

export interface DownDeps {
  cwd: string;
  out: (line: string) => void;
  execFile?: ExecFile;
  processes?: ServiceProcesses;
}

/**
 * The inverse of `up`: stops the service process, then the Postgres container.
 * `docker compose down` runs without `-v`, so the volume and every run's
 * history survive for the next `up`.
 */
export async function downFactory(deps: DownDeps): Promise<void> {
  const execFile = deps.execFile ?? nodeExecFile;
  const factoryRoot = locateFactoryRoot(deps.cwd);
  await stopService({ cwd: factoryRoot, out: deps.out, processes: deps.processes });
  // Asked before `down`, which removes the container compose would name.
  const { container, volume } = await postgresNames(execFile, factoryRoot);
  await dockerCompose(execFile, factoryRoot, ["down"], deps.out);
  deps.out(
    `stopped postgres container${container === undefined ? "" : ` ${container}`}${volume === undefined ? "" : `  (data kept in volume ${volume})`}`,
  );
  deps.out("");
  deps.out(`${factoryName(factoryRoot)} is down — start again with pnpm exec jigs up`);
}
