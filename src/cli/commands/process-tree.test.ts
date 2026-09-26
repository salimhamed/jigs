import { expect, test } from "vitest";
import { JigsError } from "../../errors.ts";
import {
  judgeRecord,
  type ProcessControl,
  parsePs,
  procStatStartTime,
  type ServiceRecord,
  selectServiceProcesses,
  stopProcessTree,
} from "./process-tree.ts";

// What `ps -A -ww -o pid=,ppid=,pgid=,stat=,command=` prints: right-aligned
// numbers, a state, and a command that keeps its own spaces.
const PS = `
    1     0     1 Ss   /sbin/init splash
  500     1   500 Ss   -zsh
  501   500   501 S+   node /usr/bin/jigs service stop
  700     1   700 Ss   node .output/server/index.mjs
  710   700   700 Sl   claude --print "fix  the bug"
  720   710   720 Ss   bash -c pnpm test
  721   720   720 S    node   vitest run
  730     1   700 S    sleep 600
  740   700   700 Z    [git] <defunct>
  800     1   800 Ss   postgres -D /var/lib/postgres/data
`;

const pids = (entries: Array<{ pid: number }>) => entries.map((entry) => entry.pid);
const service = { servicePid: 700, processGroup: 700 };

test("ps rows parse with the command's own spaces kept and zombies left out", () => {
  const entries = parsePs(PS);
  expect(entries.find((entry) => entry.pid === 710)).toEqual({
    pid: 710,
    ppid: 700,
    pgid: 700,
    command: 'claude --print "fix  the bug"',
  });
  expect(entries.find((entry) => entry.pid === 721)?.command).toBe("node   vitest run");
  expect(pids(entries)).not.toContain(740);
  expect(entries).toHaveLength(9);
});

test("selection is the service, its descendants in any group, and orphans still in its group", () => {
  const selected = selectServiceProcesses(parsePs(PS), service, { self: 501 });
  expect(pids(selected)).toEqual([700, 710, 720, 721, 730]);
});

test("stopping the service from inside it is refused", () => {
  const ps = `${PS}  750   710   760 S    node /usr/bin/jigs service restart\n`;
  expect(() => selectServiceProcesses(parsePs(ps), service, { self: 750 })).toThrow(
    "refusing to stop the service from inside it",
  );
});

test("a process selected earlier stays selected after its parent exits, by pid and command", () => {
  const ps = "  720     1   720 Ss   bash -c pnpm test\n  721   720   720 S    node vitest run\n";
  const known = new Map([[720, "bash -c pnpm test"]]);
  expect(pids(selectServiceProcesses(parsePs(ps), {}, { self: 1, known }))).toEqual([720, 721]);
  const reused = new Map([[720, "something else"]]);
  expect(selectServiceProcesses(parsePs(ps), {}, { self: 1, known: reused })).toEqual([]);
});

const RECORD: ServiceRecord = {
  processGroup: 700,
  bootId: "boot-1",
  startTime: "Fri Sep 25 09:00:00 2026",
  command: "/usr/bin/node .output/server/index.mjs",
};

const observe = (ps: string, bootId = "boot-1", startTime = RECORD.startTime) => ({
  bootId,
  entries: parsePs(ps),
  startTime: () => startTime,
});

// The records name pid 612, which a tmux server now has, with shells in it.
const TMUX = `
  612     1   612 Ss   tmux new -s work
  613   612   613 Ss   -zsh
  614   613   613 S+   vim notes.md
`;

test("a record whose pid now leads someone else's group selects nothing", () => {
  const record = { ...RECORD, processGroup: 612 };
  const verdict = judgeRecord(record, observe(TMUX, "boot-1", "Fri Sep 25 08:00:00 2026"));
  expect(verdict.kind).toBe("reused");
  expect(selectServiceProcesses(parsePs(TMUX), {}, { self: 1 })).toEqual([]);
});

test("a record from before the machine restarted names nothing running", () => {
  const record = { ...RECORD, processGroup: 612 };
  expect(judgeRecord(record, observe(TMUX, "boot-2")).kind).toBe("previous-boot");
});

test("with the service gone, what is left in its group is still its own", () => {
  const ps = "  730     1   700 S    sleep 600\n  800     1   800 Ss   postgres\n";
  expect(judgeRecord(RECORD, observe(ps)).kind).toBe("leader-gone");
  expect(pids(selectServiceProcesses(parsePs(ps), { processGroup: 700 }, { self: 1 }))).toEqual([
    730,
  ]);
});

test("the recorded pid is the service only when its start time and command both match", () => {
  const ps = `  700     1   700 Ss   ${RECORD.command}\n`;
  expect(judgeRecord(RECORD, observe(ps)).kind).toBe("service");
  expect(judgeRecord(RECORD, observe(ps, "boot-1", "Fri Sep 25 10:00:00 2026")).kind).toBe(
    "reused",
  );
  const other = "  700     1   700 Ss   /usr/bin/node other.mjs\n";
  expect(judgeRecord(RECORD, observe(other)).kind).toBe("reused");
});

type Behaviour = "exits" | "ignores-term" | "immortal" | "denied";

interface FakeProcess {
  ppid: number;
  pgid: number;
  command: string;
  behaviour: Behaviour;
  onTerm?: () => void;
}

function machine(table: Map<number, FakeProcess>) {
  const signals: Array<[number, NodeJS.Signals | 0]> = [];
  const control: ProcessControl = {
    snapshot: () =>
      [...table].map(([pid, p]) => `${pid} ${p.ppid} ${p.pgid} S ${p.command}\n`).join(""),
    bootId: () => "boot-1",
    startTime: () => undefined,
    signal(pid, sig) {
      signals.push([pid, sig]);
      const p = table.get(pid);
      if (p === undefined) return false;
      if (p.behaviour === "denied") {
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      }
      if (sig === "SIGTERM") p.onTerm?.();
      if (
        (sig === "SIGTERM" && p.behaviour === "exits") ||
        (sig === "SIGKILL" && p.behaviour !== "immortal")
      ) {
        table.delete(pid);
      }
      return true;
    },
  };
  return { control, signals };
}

const quick = { timeoutMs: 30, pollMs: 1, killWaitMs: 10, self: 1 };

const proc = (
  ppid: number,
  pgid: number,
  command: string,
  behaviour: Behaviour = "exits",
): FakeProcess => ({ ppid, pgid, command, behaviour });

test("everything selected gets SIGTERM, and what outlives the grace gets SIGKILL", async () => {
  const table = new Map([
    [700, proc(1, 700, "node .output/server/index.mjs")],
    [710, proc(700, 710, "claude --print hi", "ignores-term")],
    [800, proc(1, 800, "postgres")],
  ]);
  const { control, signals } = machine(table);

  const result = await stopProcessTree(control, service, quick);

  expect(signals).toContainEqual([700, "SIGTERM"]);
  expect(signals).toContainEqual([710, "SIGTERM"]);
  expect(signals).toContainEqual([710, "SIGKILL"]);
  expect(signals).not.toContainEqual([700, "SIGKILL"]);
  expect(signals.some(([pid]) => pid === 800)).toBe(false);
  expect(pids(result.stopped)).toEqual([700, 710]);
  expect(pids(result.killed)).toEqual([710]);
  expect([...table.keys()]).toEqual([800]);
});

test("a process started during the stop is caught by the next snapshot", async () => {
  const table = new Map<number, FakeProcess>([
    [700, proc(1, 700, "node .output/server/index.mjs")],
  ]);
  const agent = proc(700, 700, "codex exec", "ignores-term");
  agent.onTerm = () => table.set(760, proc(1, 700, "git fetch", "ignores-term"));
  table.set(710, agent);
  const { control, signals } = machine(table);

  await stopProcessTree(control, service, quick);

  expect(signals).toContainEqual([760, "SIGTERM"]);
  expect(signals).toContainEqual([760, "SIGKILL"]);
  expect(table.size).toBe(0);
});

test("a process that survives SIGKILL fails the stop with its pid and command", async () => {
  const table = new Map([
    [700, proc(1, 700, "node .output/server/index.mjs")],
    [710, proc(700, 700, "stuck --in D state", "immortal")],
  ]);
  const { control } = machine(table);

  const error = await stopProcessTree(control, service, quick).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(JigsError);
  expect((error as JigsError).message).toContain("pid 710: stuck --in D state");
  expect((error as JigsError).hint).toContain("710");
});

test("a process jigs may not signal is reported as a survivor", async () => {
  const table = new Map([
    [700, proc(1, 700, "node .output/server/index.mjs")],
    [710, proc(700, 700, "sudo docker compose up", "denied")],
  ]);
  const { control } = machine(table);

  const error = await stopProcessTree(control, service, quick).catch((caught: unknown) => caught);

  expect((error as JigsError).message).toContain(
    "pid 710 (not permitted to signal): sudo docker compose up",
  );
});

test("a process already gone when signalled is fine", async () => {
  const table = new Map([[700, proc(1, 700, "node .output/server/index.mjs")]]);
  const { control } = machine(table);
  control.signal = () => {
    table.clear();
    return false;
  };

  await expect(stopProcessTree(control, service, quick)).resolves.toMatchObject({
    killed: [],
  });
});

test("the start time is read after the last parenthesis of a Linux stat line", () => {
  const fields = Array.from({ length: 50 }, (_, i) => String(i + 3));
  fields[0] = "S";
  const stat = `4242 (node (worker) x) ${fields.join(" ")}\n`;
  expect(procStatStartTime(stat)).toBe("22");
  expect(procStatStartTime("4242 (node")).toBeUndefined();
});
