// Which services on this machine hold Socket Mode connections for which Slack
// app. Slack spreads one app's events across every open connection, so two
// factories on one app each miss about half of them; a service's own records
// under services/ name no factory, so this is the only place one service can
// see another's app. Entries are keyed by a hash of the app-level token, never
// the token itself.

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import path from "node:path";
import { jigsDataDir } from "./factory-context.ts";

/** A service holding Socket Mode connections for one Slack app. */
export interface SlackAppHolder {
  slug: string;
  pid: number;
  startedAt: string;
}

export interface SlackAppsOptions {
  /** Defaults to the jigs data directory. */
  dataDir?: string;
}

/** A short, one-way name for the Slack app an app-level token belongs to. */
export function slackAppFingerprint(appToken: string): string {
  return createHash("sha256").update(appToken).digest("hex").slice(0, 12);
}

function appDir(appToken: string, options: SlackAppsOptions): string {
  return path.join(options.dataDir ?? jigsDataDir(), "slack-apps", slackAppFingerprint(appToken));
}

// An entry written before this boot is stale whatever its pid answers: a
// crash or SIGKILL leaves the file behind, and after a reboot its pid may
// belong to an unrelated process.
function isAlive(holder: SlackAppHolder): boolean {
  if (Date.parse(holder.startedAt) < Date.now() - uptime() * 1000) return false;
  try {
    process.kill(holder.pid, 0);
    return true;
  } catch (err) {
    // EPERM is a live process this user may not signal.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readHolder(file: string): SlackAppHolder | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<SlackAppHolder>;
    if (
      typeof parsed.slug !== "string" ||
      !Number.isInteger(parsed.pid) ||
      typeof parsed.startedAt !== "string"
    )
      return undefined;
    return parsed as SlackAppHolder;
  } catch {
    return undefined;
  }
}

// Deletes the entry only while it still names `pid`, so a service of that slug
// that has since re-registered keeps its entry.
function forgetIfStill(file: string, pid: number): void {
  if (readHolder(file)?.pid === pid) rmSync(file, { force: true });
}

/**
 * The live services other than `slug` holding Socket Mode for the same Slack
 * app. Entries whose process is gone, or that predate this boot, are deleted
 * on the way.
 */
export function otherSlackAppHolders(
  appToken: string,
  slug: string,
  options: SlackAppsOptions = {},
): SlackAppHolder[] {
  const dir = appDir(appToken, options);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const others: SlackAppHolder[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    const file = path.join(dir, name);
    const holder = readHolder(file);
    if (holder === undefined || holder.slug === slug) continue;
    if (isAlive(holder)) others.push(holder);
    else forgetIfStill(file, holder.pid);
  }
  return others;
}

/** This service's entry for a Slack app, and the other live holders when it was made. */
export interface SlackAppHold {
  others: SlackAppHolder[];
  /** Remove the entry, unless another process of the same slug has since replaced it. */
  forget(): void;
}

/** Record that this process holds Socket Mode connections for the token's Slack app. */
export function holdSlackApp(
  appToken: string,
  slug: string,
  options: SlackAppsOptions & { pid?: number; now?: () => Date } = {},
): SlackAppHold {
  const pid = options.pid ?? process.pid;
  const dir = appDir(appToken, options);
  const file = path.join(dir, `${slug}.json`);
  const holder: SlackAppHolder = {
    slug,
    pid,
    startedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  mkdirSync(dir, { recursive: true });
  // A reader never sees half a file.
  const temp = `${file}.${pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(holder)}\n`);
    renameSync(temp, file);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
  return {
    others: otherSlackAppHolders(appToken, slug, options),
    forget: () => forgetIfStill(file, pid),
  };
}
