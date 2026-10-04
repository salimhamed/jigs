import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  judgeRecord,
  parsePs,
  selectServiceProcesses,
  stopProcessTree,
  systemProcesses,
} from "./process-tree.ts";

const IDLE = "setInterval(() => {}, 1000)";
const STUBBORN = `process.on("SIGTERM", () => {}); ${IDLE}`;

// A stand-in service that starts one child in a process group of its own,
// which also ignores SIGTERM, and one grandchild whose parent exits at once,
// leaving it orphaned in the service's group.
const SERVICE = `
const { spawn } = require("node:child_process");
const node = process.execPath;
spawn(node, ["-e", ${JSON.stringify(STUBBORN)}], { detached: true, stdio: "ignore" });
const orphan = ${JSON.stringify(`require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(IDLE)}], { stdio: "ignore" }).unref(); process.exit(0)`)};
spawn(node, ["-e", orphan], { stdio: "ignore" });
${IDLE};
`;

test("stopping a real service ends its child in another group and its orphan in the group", async () => {
  const service = spawn(process.execPath, ["-e", SERVICE], { detached: true, stdio: "ignore" });
  const pid = service.pid as number;
  const target = { servicePid: pid, processGroup: pid };
  const select = () =>
    selectServiceProcesses(parsePs(systemProcesses.snapshot()), target, { self: process.pid });

  let started = select();
  for (let tries = 0; started.length < 3 && tries < 100; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    started = select();
  }
  expect(started).toHaveLength(3);
  expect(started.some((entry) => entry.pgid !== pid)).toBe(true);
  expect(started.some((entry) => entry.pid !== pid && entry.ppid !== pid)).toBe(true);

  const result = await stopProcessTree(systemProcesses, target, {
    timeoutMs: 1_000,
    pollMs: 50,
    killWaitMs: 2_000,
  });

  expect(result.stopped.map((entry) => entry.pid).sort()).toEqual(
    started.map((entry) => entry.pid).sort(),
  );
  expect(result.killed).toHaveLength(1);
  const left = new Set(parsePs(systemProcesses.snapshot()).map((entry) => entry.pid));
  for (const entry of started) expect(left.has(entry.pid)).toBe(false);
});

test("a service is known again by boot ID, start time and command as ps reports them", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "jigs-process-tree-"));
  const entry = path.join(dir, "index.mjs");
  writeFileSync(entry, `${IDLE};\n`);
  const service = spawn(process.execPath, [entry], { detached: true, stdio: "ignore" });
  const pid = service.pid as number;
  try {
    const record = {
      processGroup: pid,
      bootId: systemProcesses.bootId(),
      startTime: systemProcesses.startTime(pid) ?? "",
      command: `${process.execPath} ${entry}`,
    };
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const verdict = judgeRecord(record, {
      bootId: systemProcesses.bootId(),
      entries: parsePs(systemProcesses.snapshot()),
      startTime: (leader) => systemProcesses.startTime(leader),
    });

    expect(record.bootId).not.toBe("");
    expect(record.startTime).not.toBe("");
    expect(verdict.kind).toBe("service");
  } finally {
    process.kill(pid, "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
