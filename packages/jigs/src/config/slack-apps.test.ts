import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, uptime } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { holdSlackApp, otherSlackAppHolders, slackAppFingerprint } from "./slack-apps.ts";

const TOKEN = "xapp-1-A0C5JPZUW1J-1234567890-abcdef";
const OTHER_TOKEN = "xapp-1-A0OTHERAPP-1234567890-abcdef";
// A pid no process has: above Linux's pid_max.
const DEAD_PID = 2 ** 22 + 1;

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "jigs-slack-apps-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const appDir = (token = TOKEN) => path.join(dataDir, "slack-apps", slackAppFingerprint(token));
const STARTED = new Date();
const now = () => STARTED;

test("the fingerprint is twelve hex characters and never the token", () => {
  const fingerprint = slackAppFingerprint(TOKEN);
  expect(fingerprint).toMatch(/^[0-9a-f]{12}$/);
  expect(slackAppFingerprint(OTHER_TOKEN)).not.toBe(fingerprint);
});

test("holding writes the slug, pid and start time under the fingerprint, and no token", () => {
  holdSlackApp(TOKEN, "factory-a", { dataDir, now });
  const file = path.join(appDir(), "factory-a.json");
  const written = readFileSync(file, "utf8");
  expect(JSON.parse(written)).toEqual({
    slug: "factory-a",
    pid: process.pid,
    startedAt: STARTED.toISOString(),
  });
  expect(written).not.toContain(TOKEN);
  expect(readdirSync(appDir())).toEqual(["factory-a.json"]);
  expect(readdirSync(path.join(dataDir, "slack-apps"))).toEqual([slackAppFingerprint(TOKEN)]);
});

test("a second service on the same app sees the first; one on another app does not", () => {
  const first = holdSlackApp(TOKEN, "factory-a", { dataDir });
  expect(first.others).toEqual([]);
  const second = holdSlackApp(TOKEN, "factory-b", { dataDir });
  expect(second.others.map((holder) => holder.slug)).toEqual(["factory-a"]);
  expect(holdSlackApp(OTHER_TOKEN, "factory-c", { dataDir }).others).toEqual([]);
  expect(otherSlackAppHolders(TOKEN, "factory-a", { dataDir }).map((h) => h.slug)).toEqual([
    "factory-b",
  ]);
});

test("an entry whose process is gone is not a holder and is deleted", () => {
  holdSlackApp(TOKEN, "factory-a", { dataDir, pid: DEAD_PID });
  expect(otherSlackAppHolders(TOKEN, "factory-b", { dataDir })).toEqual([]);
  expect(readdirSync(appDir())).toEqual([]);
});

test("an entry written before this boot is stale even if its pid is in use", () => {
  holdSlackApp(TOKEN, "factory-a", {
    dataDir,
    pid: process.ppid,
    now: () => new Date(Date.now() - uptime() * 1000 - 60_000),
  });
  expect(otherSlackAppHolders(TOKEN, "factory-b", { dataDir })).toEqual([]);
  expect(readdirSync(appDir())).toEqual([]);
});

test("a live service's entry is never deleted as stale", () => {
  holdSlackApp(TOKEN, "factory-a", { dataDir, pid: process.ppid });
  expect(otherSlackAppHolders(TOKEN, "factory-b", { dataDir })).toHaveLength(1);
  expect(readdirSync(appDir())).toEqual(["factory-a.json"]);
});

test("forget removes only this service's own entry", () => {
  const own = holdSlackApp(TOKEN, "factory-a", { dataDir });
  holdSlackApp(TOKEN, "factory-b", { dataDir });
  own.forget();
  expect(readdirSync(appDir())).toEqual(["factory-b.json"]);
});

test("forget leaves an entry a later process of the same slug has written", () => {
  const old = holdSlackApp(TOKEN, "factory-a", { dataDir, pid: DEAD_PID });
  holdSlackApp(TOKEN, "factory-a", { dataDir });
  old.forget();
  expect(readdirSync(appDir())).toEqual(["factory-a.json"]);
});

test("an unreadable entry is skipped and left alone", () => {
  holdSlackApp(TOKEN, "factory-a", { dataDir });
  writeFileSync(path.join(appDir(), "factory-x.json"), "{");
  expect(otherSlackAppHolders(TOKEN, "factory-b", { dataDir }).map((h) => h.slug)).toEqual([
    "factory-a",
  ]);
  expect(readdirSync(appDir()).sort()).toEqual(["factory-a.json", "factory-x.json"]);
});
