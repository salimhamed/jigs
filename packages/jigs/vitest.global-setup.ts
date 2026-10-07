import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// One temp root per run, holding the jigs data directory too, so tests never leave
// files in /tmp or the developer's ~/.local/share/jigs.
export default function setup(): () => void {
  const root = mkdtempSync(path.join(tmpdir(), "jigs-vitest-"));
  process.env.TMPDIR = root;
  process.env.XDG_DATA_HOME = path.join(root, "data");
  return () => rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
