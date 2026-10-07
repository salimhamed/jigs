import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { ConversationMessage, TurnRequest } from "../../../workflow/agents/conversation.ts";
import { harnesses } from "../../../workflow/agents/harness-config.ts";
import { executeTurn } from "../shared/execute-turn.ts";
import { assertLivePreconditions, makeScratchRepo } from "../shared/live-env.ts";
import { liveTurn } from "../shared/live-turns.ts";
import { makeTmpDir, removeTmpDir } from "../shared/test-fixtures.ts";
import type { TurnEvent } from "../shared/types.ts";

// Outside a factory there is no jigs.config.ts declaring agent variables.
vi.mock("../shared/env.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/env.ts")>()),
  factoryAgentEnv: () => [],
}));
// Outside a run there is no World status to watch; the run stays running.
vi.mock("../../../run-cancellation.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../run-cancellation.ts")>()),
  worldRunStatus: {
    read: async () => "running",
    waitForTerminal: (_runId: string, timeoutMs: number) =>
      new Promise((resolve) => setTimeout(() => resolve("running"), timeoutMs).unref()),
  },
}));

let tmp: string;
const savedDataHome = process.env.XDG_DATA_HOME;
beforeAll(() => {
  assertLivePreconditions();
  tmp = makeTmpDir();
  process.env.XDG_DATA_HOME = path.join(tmp, "data");
});
afterAll(() => {
  removeTmpDir(tmp);
  if (savedDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedDataHome;
});

const SLOW_SECONDS = 20;

// Claude Code's Bash refuses a bare long sleep, so the wait sits in a script.
function slowRepo(name: string): string {
  const repo = makeScratchRepo(tmp, name);
  const script = path.join(repo, "slow.sh");
  writeFileSync(
    script,
    `#!/bin/sh\necho $$ > slow.pid\nsleep ${SLOW_SECONDS}\necho SLOW-DONE\ntouch finished.txt\n`,
  );
  chmodSync(script, 0o755);
  return repo;
}

const say = (text: string): ConversationMessage => ({
  uuid: crypto.randomUUID(),
  author: "Salim Hamed",
  text,
});

const runSlow = say(
  `Run ./slow.sh with the Bash tool in the foreground (it takes about ${SLOW_SECONDS} seconds), then reply with its output.`,
);

function request(cwd: string, messages: ConversationMessage[]): TurnRequest {
  return {
    harness: harnesses.claude({ model: "haiku", maxTurns: 10 }),
    cwd,
    conversation: `live:${crypto.randomUUID()}`,
    messages,
  };
}

const metadata = () => ({ workflowRunId: `live-converse-${crypto.randomUUID()}` });

// Calls `then` once, a few seconds after Claude starts its Bash command.
function onceBashRuns(then: () => void) {
  let fired = false;
  return (event: TurnEvent) => {
    if (fired || event.type !== "part" || event.part.type !== "tool-call") return;
    if (event.part.toolName !== "Bash") return;
    fired = true;
    setTimeout(then, 3_000);
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a message sent while Claude runs a command is folded into the same turn", async () => {
  const repo = slowRepo("converse-inject");
  const turn = request(repo, [runSlow]);
  const aside = say("While that runs: also put the word PINEAPPLE in your reply.");
  let injected: boolean | undefined;

  const result = await executeTurn(turn, metadata(), [
    onceBashRuns(() => {
      injected = liveTurn(turn.conversation)?.inject(aside);
    }),
  ]);

  expect(injected).toBe(true);
  expect(result.outcome).toBe("finished");
  expect(result.consumed).toEqual([runSlow.uuid, aside.uuid]);
  expect(result.replies).toHaveLength(1);
  expect(result.replies[0]?.text).toMatch(/SLOW-DONE/);
  expect(result.replies[0]?.text).toMatch(/PINEAPPLE/);
}, 180_000);

test("stop interrupts the command and drops the queued message", async () => {
  const repo = slowRepo("converse-stop");
  const turn = request(repo, [runSlow]);
  const queued = say("Then write queued.txt containing yes.");

  const result = await executeTurn(turn, metadata(), [
    onceBashRuns(() => {
      const live = liveTurn(turn.conversation);
      live?.inject(queued);
      // Late enough that Claude Code holds the message in its own queue.
      setTimeout(() => live?.stop(), 2_000);
    }),
  ]);

  expect(result.outcome).toBe("stopped");
  expect(result.consumed).not.toContain(queued.uuid);
  const pid = Number(readFileSync(path.join(repo, "slow.pid"), "utf8"));
  await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5_000 });
  await new Promise((resolve) => setTimeout(resolve, (SLOW_SECONDS + 2) * 1_000));
  expect(existsSync(path.join(repo, "finished.txt"))).toBe(false);
  expect(existsSync(path.join(repo, "queued.txt"))).toBe(false);
}, 180_000);

type Groups = { groups: Map<number, { owner: string }> };

test("a turn killed mid-command continues on replay instead of starting over", async () => {
  const repo = slowRepo("converse-replay");
  const turn = request(repo, [runSlow]);
  const run = metadata();

  await expect(
    executeTurn(turn, run, [
      onceBashRuns(() => {
        // What a crashed service leaves: Claude Code killed outright, mid-command.
        const { groups } = (globalThis as Record<symbol, Groups>)[
          Symbol.for("jigs.processGroups")
        ] as Groups;
        for (const [pgid, { owner }] of groups) {
          if (owner.includes(run.workflowRunId)) process.kill(-pgid, "SIGKILL");
        }
      }),
    ]),
  ).rejects.toThrow();

  const sent: string[] = [];
  const replay = await executeTurn(turn, run, [
    (event) => {
      if (event.type === "start") sent.push(`resume:${event.resume}`);
    },
  ]);

  expect(sent).toEqual(["resume:true"]);
  expect(replay.outcome).toBe("finished");
  expect(replay.consumed).toEqual([runSlow.uuid]);
  expect(replay.replies).toHaveLength(1);
  expect(replay.replies[0]?.consumed).toEqual([]);
}, 240_000);
