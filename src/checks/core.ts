// The service belongs to a factory repo, so its environment file is that
// repo's own .env and the restart is the CLI verb that supervises it — both
// stay correct for whichever factory raised the check, unlike the single
// global path and unit name they replace.
export const SERVICE_ENV_FILE = "the factory repo's .env";
export const RESTART_SERVICE = "pnpm exec jigs service restart";

export type Integration = "linear" | "github";
