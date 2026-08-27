import type { Sql } from "postgres";
import { connectRegistry } from "./registry";

// One lazily-opened registry connection for the process: the plugin's
// startup ensure, the step-side provision, and the sweep all share it, so
// nothing ends a pool another caller still holds.

let client: Sql | null = null;

export function registrySql(): Sql | null {
  const url = process.env.WORKFLOW_POSTGRES_URL;
  if (url === undefined || url === "") return null;
  client ??= connectRegistry(url);
  return client;
}
