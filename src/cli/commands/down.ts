import { resolveService } from "../../config/factory-config.ts";
import { locateFactoryRoot } from "../../config/factory-root.ts";
import { type ExecFile, nodeExecFile } from "../exec.ts";
import { dockerCompose } from "./compose.ts";
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
  const factoryRoot = locateFactoryRoot(deps.cwd);
  const { slug } = resolveService(factoryRoot);
  await stopService({ cwd: factoryRoot, out: deps.out, processes: deps.processes });
  await dockerCompose(deps.execFile ?? nodeExecFile, factoryRoot, ["down"], deps.out);
  deps.out("stopped postgres container (docker compose down); data kept in its volume");
  deps.out(`${slug} is down — start again with pnpm exec jigs up`);
}
