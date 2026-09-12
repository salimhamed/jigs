import { homedir } from "node:os";
import path from "node:path";

export function jigsDataDir(): string {
  return path.join(process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share"), "jigs");
}

// `jigs bind` writes it, the ingress reads it; both name the file from here.
export function githubWebhookSecretFile(dataDir: string = jigsDataDir()): string {
  return path.join(dataDir, "github-webhook-secret");
}
