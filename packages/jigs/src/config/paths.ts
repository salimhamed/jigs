import { createHash } from "node:crypto";
import path from "node:path";

// Binding names are unique only per factory repo, so the path needs factory
// identity — dirname alone would collide two factories named the same, and it
// is what keeps two factories' clones of one remote apart.
export function factorySlug(factoryRoot: string): string {
  const resolved = path.resolve(factoryRoot);
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  return `${path.basename(resolved)}-${hash}`;
}
