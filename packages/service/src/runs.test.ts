import { expect, test } from "vitest";
import { listRuns, resolveRunRef, type WorldRun } from "./runs";

const RUN_A = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";
const RUN_B = "wrun_01K3ANC1P0R4S6TXZ8B3F5G7HJ";

const lookupDeps = (runIds: string[], hooks: Record<string, string> = {}) => ({
  listRunIds: async () => runIds,
  runExists: async (id: string) => runIds.includes(id),
  hookRunId: async (token: string) => hooks[token] ?? null,
});

test("a full run id resolves to itself", async () => {
  const ref = await resolveRunRef(RUN_A, lookupDeps([RUN_A, RUN_B]));
  expect(ref).toEqual({ kind: "found", runId: RUN_A });
});

test("a unique ULID prefix resolves, case-insensitively and bare", async () => {
  const ref = await resolveRunRef("01k3anbz", lookupDeps([RUN_A, RUN_B]));
  expect(ref).toEqual({ kind: "found", runId: RUN_A });
});

test("the same prefix resolves with the wrun_ prefix typed out", async () => {
  const ref = await resolveRunRef("wrun_01K3ANBZ", lookupDeps([RUN_A, RUN_B]));
  expect(ref).toEqual({ kind: "found", runId: RUN_A });
});

test("a prefix matching two runs is ambiguous and names both", async () => {
  const ref = await resolveRunRef("01K3AN", lookupDeps([RUN_A, RUN_B]));
  expect(ref.kind).toBe("ambiguous");
  expect(ref.kind === "ambiguous" && ref.candidates).toEqual([RUN_A, RUN_B]);
});

test("a ticket id resolves through its claim hook", async () => {
  const ref = await resolveRunRef(
    "AGE-317",
    lookupDeps([RUN_A], { "linear:ticket:AGE-317": RUN_A }),
  );
  expect(ref).toEqual({ kind: "found", runId: RUN_A });
});

test("a ticket UUID — what today's pipelines claim with — resolves the same way", async () => {
  const issueId = crypto.randomUUID();
  const ref = await resolveRunRef(
    issueId,
    lookupDeps([RUN_B], { [`linear:ticket:${issueId}`]: RUN_B }),
  );
  expect(ref).toEqual({ kind: "found", runId: RUN_B });
});

test("a ref nothing holds is unknown", async () => {
  const ref = await resolveRunRef("AGE-999", lookupDeps([RUN_A]));
  expect(ref).toEqual({ kind: "unknown" });
});

test("a full-length run id nobody minted falls through to unknown", async () => {
  const ref = await resolveRunRef(
    "wrun_01ZZZZZZZZZZZZZZZZZZZZZZZZ",
    lookupDeps([RUN_A]),
  );
  expect(ref).toEqual({ kind: "unknown" });
});

const worldRun = (over: Partial<WorldRun> = {}): WorldRun => ({
  runId: RUN_A,
  workflowName: "workflow//./pipelines/demo//demoPipeline",
  status: "running",
  createdAt: new Date("2026-08-26T10:00:00.000Z"),
  ...over,
});

test("a non-terminal run holding a park hook is reported suspended", async () => {
  const rows = await listRuns({
    listRuns: async () => [worldRun()],
    listHooks: async () => [{ runId: RUN_A, token: "github:pr:acme/api#41" }],
  });
  expect(rows[0]?.status).toBe("suspended");
});

test("a run holding only its ticket claim is still running, not suspended", async () => {
  const rows = await listRuns({
    listRuns: async () => [worldRun()],
    listHooks: async () => [
      { runId: RUN_A, token: `linear:ticket:${crypto.randomUUID()}` },
    ],
  });
  expect(rows[0]?.status).toBe("running");
});

test("a terminal run that still lists a hook keeps its own status", async () => {
  const rows = await listRuns({
    listRuns: async () => [worldRun({ status: "failed" })],
    listHooks: async () => [{ runId: RUN_A, token: "github:pr:acme/api#41" }],
  });
  expect(rows[0]?.status).toBe("failed");
});

test("runs are listed newest first", async () => {
  const rows = await listRuns({
    listRuns: async () => [
      worldRun({ createdAt: new Date("2026-08-26T09:00:00.000Z") }),
      worldRun({
        runId: RUN_B,
        createdAt: new Date("2026-08-26T11:00:00.000Z"),
      }),
    ],
    listHooks: async () => [],
  });
  expect(rows.map((row) => row.runId)).toEqual([RUN_B, RUN_A]);
});

test("an unmapped workflow name is reported verbatim rather than guessed at", async () => {
  const rows = await listRuns({
    listRuns: async () => [worldRun()],
    listHooks: async () => [],
  });
  expect(rows[0]?.pipeline).toBe("workflow//./pipelines/demo//demoPipeline");
});
