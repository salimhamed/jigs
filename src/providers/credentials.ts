// Where every provider credential comes from, and the one reset that makes a
// process forget them all.

import { factoryEnvValue } from "../config/factory-env.ts";
import { factoryRoot } from "../config/factory-root.ts";
import { JigsError } from "../errors.ts";

// The service belongs to a factory repo, so its environment file is that
// repo's own .env and the restart is the CLI verb that supervises it.
export const SERVICE_ENV_FILE = "the factory repo's .env";
export const RESTART_SERVICE = "pnpm exec jigs service restart";

export type EnvLookup = (name: string) => string | undefined;

// The service answers for the factory it was started with; a CLI verb locates
// one from the directory the operator typed it in, which is not necessarily
// the process's own. Naming it is how every provider credential follows.
let override: string | null = null;

export function setCredentialRoot(root: string | null): void {
  override = root;
}

export const credentialRoot = (): string => override ?? factoryRoot();

/** A credential from the factory's `.env`, or the shell outside a factory. Empty is unset. */
export function credentialValue(name: string): string | undefined {
  try {
    return factoryEnvValue(credentialRoot(), name);
  } catch {
    const exported = process.env[name];
    return exported === "" ? undefined : exported;
  }
}

/** The credential's value, or a failure that says where to set it and what needs it. */
export function requireCredential(
  name: string,
  neededBy?: string,
  env: EnvLookup = credentialValue,
): string {
  const value = env(name);
  if (value === undefined || value === "") {
    throw new JigsError(
      `${name} is not set${neededBy === undefined ? "" : `, and ${neededBy} needs it`}`,
      `set ${name} in ${SERVICE_ENV_FILE}, then: \`${RESTART_SERVICE}\``,
    );
  }
  return value;
}

const resets = new Set<() => void>();

/** Run `reset` whenever the process forgets its provider credentials. Call it once, at module load. */
export function onProviderReset(reset: () => void): void {
  resets.add(reset);
}

/** Forget every cached provider credential and identity, and the credential root. */
export function resetProviderContext(): void {
  for (const reset of resets) reset();
  setCredentialRoot(null);
}

/** Point every provider credential at one factory, for a CLI verb run outside it. */
export function useFactoryRoot(root: string): void {
  resetProviderContext();
  setCredentialRoot(root);
}
