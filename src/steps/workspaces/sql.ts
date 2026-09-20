import type { RegistrySql } from "./registry.ts";
import { connectRegistry } from "./registry.ts";

// One lazily-opened registry connection for the process: the plugin's
// startup ensure, step-side provision, and automatic release all share it, so
// nothing ends a pool another caller still holds. The service owns process
// exit after World shutdown drains active work; a concurrent pool.end() would
// race steps still running during that drain. CLI migrations use their own pool.

let client: RegistrySql | undefined;

export function registrySql(): RegistrySql {
  if (client === undefined) {
    const url = process.env.WORKFLOW_POSTGRES_URL;
    if (url === undefined || url === "") {
      throw new Error("WORKFLOW_POSTGRES_URL is not set");
    }
    client = connectRegistry(url);
  }
  return client;
}
