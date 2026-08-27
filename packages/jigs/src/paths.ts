import { homedir } from "node:os";
import path from "node:path";

export function jigsDataDir(): string {
  return path.join(
    process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share"),
    "jigs",
  );
}

export function expandHome(p: string, home: string = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

export function contractHome(p: string, home: string = homedir()): string {
  const resolved = path.resolve(p);
  if (resolved === home) return "~";
  if (resolved.startsWith(home + path.sep)) {
    return `~/${path.relative(home, resolved)}`;
  }
  return resolved;
}
