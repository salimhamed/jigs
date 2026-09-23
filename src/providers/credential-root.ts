import { factoryRoot } from "../config/factory-root.ts";

// The service answers for the factory it was started with; a CLI verb locates
// one from the directory the operator typed it in, which is not necessarily
// the process's own. Naming it is how every provider credential follows.
let override: string | null = null;

export function setCredentialRoot(root: string | null): void {
  override = root;
}

export const credentialRoot = (): string => override ?? factoryRoot();
