import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The whole run gets one temp root, which also holds the jigs data directory. Test
// workers start after this and inherit both, so a fixture a test never removes, or a
// clone written under the data directory, goes with the run instead of piling up in
// /tmp or the developer's ~/.local/share/jigs.
export default function setup(): () => void {
  const root = mkdtempSync(path.join(tmpdir(), "jigs-vitest-"));
  process.env.TMPDIR = root;
  process.env.XDG_DATA_HOME = path.join(root, "data");
  return () => rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
