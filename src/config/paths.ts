import { homedir } from "node:os";
import path from "node:path";

export function jigsDataDir(): string {
  return path.join(process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share"), "jigs");
}
