import { expect, test, vi } from "vitest";
import { z } from "zod";
import { memoryTriggerStore } from "../test-fixtures.ts";
import {
  recordedOccurrences,
  startTriggers,
  withdrawInactive,
  withdrawOccurrence,
} from "./runner.ts";

const quiescers = vi.hoisted((): Array<() => Promise<void>> => []);
vi.mock("../shutdown.ts", () => ({
  onShutdown: (close: () => Promise<void>) => {
    quiescers.push(close);
  },
}));

const T0 = new Date("2026-10-07T00:00:00.000Z");

test("once the triggers shut down, a lookup rejects rather than read as no occurrence", async () => {
  const memory = memoryTriggerStore(() => T0, T0);
  startTriggers(
    {
      workflows: { respond: { workflow: async () => undefined, inputs: z.object({}) } },
      triggers: {
        pages: { active: true, workflow: "respond", source: { kind: "fake.pages", params: {} } },
      },
    },
    {
      store: memory.store,
      sources: {
        "fake.pages": {
          provider: "github",
          params: z.object({}),
          sampleInputs: {},
          fromPush: async () => null,
          describe: () => "page",
        },
      },
      factorySlug: () => "factory-a",
      now: () => T0,
      log: () => {},
      ready: () => new Promise(() => {}),
    },
  );
  expect(await recordedOccurrences("github", "P1")).toEqual([]);

  for (const close of quiescers) await close();

  await expect(recordedOccurrences("github", "P1")).rejects.toThrow("shut down");
  await expect(withdrawOccurrence({ trigger: "pages", occurrence: "P1" })).rejects.toThrow(
    "shut down",
  );
});

test("an inactive trigger's waiting occurrences are skipped, and a claimed one is left alone", async () => {
  const memory = memoryTriggerStore(() => T0, T0);
  const row = {
    trigger: "pages",
    state: "pending",
    inputs: {},
    attribute: "a",
    occurredAt: T0,
  } as const;
  await memory.store.record({ ...row, occurrence: "P1" });
  await memory.store.record({ ...row, occurrence: "P2" });
  await memory.store.attempt("pages", "P2", T0);
  await withdrawInactive(["pages"], { ready: async () => {}, store: memory.store });
  expect((await memory.store.pending("pages")).map((r) => r.occurrence)).toEqual(["P2"]);
});
