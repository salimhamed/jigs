import type { Sql } from "postgres";
import { connectRegistry } from "./registry.ts";

// One lazily-opened registry connection for the process: the plugin's
// startup ensure, the step-side provision, and the sweep all share it, so
// nothing ends a pool another caller still holds.

let client: Sql | undefined;

export function registrySql(): Sql {
  if (client === undefined) {
    const url = process.env.WORKFLOW_POSTGRES_URL;
    if (url === undefined || url === "") {
      throw new Error("WORKFLOW_POSTGRES_URL is not set");
    }
    client = connectRegistry(url);
  }
  return client;
}
