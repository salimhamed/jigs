import path from "node:path";
import { currentFactoryContext } from "../../config/factory-context.ts";
import { type ExecFile, nodeExecFile } from "../exec.ts";
import { detail, hint, section } from "../output.ts";
import { dockerCompose, postgresNames } from "./compose.ts";
import { stopService } from "./service.ts";
import type { ServiceProcesses } from "./service-process.ts";

export interface DownDeps {
  out: (line: string) => void;
  execFile?: ExecFile;
  processes?: ServiceProcesses;
}

/**
 * The inverse of `up`: stops the service and everything it started, then the
 * Postgres container.
 * `docker compose down` runs without `-v`, so the volume and every run's
 * history survive for the next `up`.
 */
export async function downFactory(deps: DownDeps): Promise<void> {
  const execFile = deps.execFile ?? nodeExecFile;
  const factoryRoot = currentFactoryContext().root;
  await stopService({ out: deps.out, processes: deps.processes });
  // Asked before `down`, which removes the container compose would name.
  const { container, volume } = await postgresNames(execFile, factoryRoot);
  await dockerCompose(execFile, factoryRoot, ["down"], deps.out);
  deps.out(
    `stopped postgres container${container === undefined ? "" : ` ${container}`}${volume === undefined ? "" : ` ${detail(`data kept in volume ${volume}`)}`}`,
  );
  const summary = section(
    `${path.basename(factoryRoot)} is down`,
    hint("start it again:", "pnpm exec jigs up"),
  );
  for (const line of ["", ...summary]) deps.out(line);
}
