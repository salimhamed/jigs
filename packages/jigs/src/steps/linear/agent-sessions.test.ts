import { beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  postActivityOnce: vi.fn(),
  setExternalUrls: vi.fn(),
  listPrompts: vi.fn(),
}));
const linearAgentFor = vi.hoisted(() => vi.fn(() => api));
vi.mock("../../providers/linear-agent.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  linearAgentFor,
}));
const dashboardRunUrl = vi.hoisted(() => vi.fn((_runId: string): string | undefined => undefined));
vi.mock("../runtime/run-context.ts", () => ({ dashboardRunUrl }));

const { listLinearAgentSessionPrompts, postLinearAgentActivity, setLinearAgentSessionUrls } =
  await import("./agent-sessions.ts");
const { stepPostingId } = await import("./needs-human-comments.ts");
const { onceActivityId } = await import("../../providers/linear-agent.ts");

const metadata = { workflowRunId: "wrun_01M26", workflowName: "chat", stepId: "step_01" };
const thought = { type: "thought", body: "Looking" } as const;
const posted = { id: "a1", createdAt: "2026-10-07T00:00:00.000Z" };

beforeEach(() => {
  vi.clearAllMocks();
});

test("an activity is posted once, through its installation, under an id the step derives", async () => {
  api.postActivityOnce.mockResolvedValueOnce(posted);
  const request = { installationName: "acme", sessionId: "s1", content: thought, ephemeral: true };

  expect(await postLinearAgentActivity(request, metadata)).toEqual(posted);

  expect(linearAgentFor).toHaveBeenCalledWith("acme");
  expect(api.postActivityOnce).toHaveBeenCalledWith("s1", thought, stepPostingId(metadata, "s1"), {
    ephemeral: true,
  });
});

test("every retry of one step names the same activity; another step names another", () => {
  const id = stepPostingId(metadata, "s1");
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(stepPostingId({ ...metadata }, "s1")).toBe(id);
  expect(stepPostingId({ ...metadata, stepId: "step_02" }, "s1")).not.toBe(id);
  expect(stepPostingId(metadata, "s2")).not.toBe(id);
});

test("an activity posted once under a key gets the same id from any step", async () => {
  api.postActivityOnce.mockResolvedValue(posted);
  const request = { installationName: "acme", sessionId: "s1", content: thought, once: "k" };
  await postLinearAgentActivity(request, metadata);
  await postLinearAgentActivity(request, { ...metadata, stepId: "step_02" });
  const ids = api.postActivityOnce.mock.calls.map(([, , id]) => id);
  expect(ids).toEqual([onceActivityId("s1", "k"), onceActivityId("s1", "k")]);
  expect(onceActivityId("s1", "k")).not.toBe(onceActivityId("s2", "k"));
});

test("the run's dashboard leads the session's links when the service hosts one", async () => {
  const pr = { label: "Pull request", url: "https://github.com/acme/app/pull/7" };
  dashboardRunUrl.mockReturnValueOnce("http://localhost:3000/run/wrun_01M26");
  await setLinearAgentSessionUrls(
    { installationName: "acme", sessionId: "s1", urls: [pr] },
    metadata,
  );
  expect(api.setExternalUrls).toHaveBeenCalledWith("s1", [
    { label: "jigs run", url: "http://localhost:3000/run/wrun_01M26" },
    pr,
  ]);
  await setLinearAgentSessionUrls(
    { installationName: "acme", sessionId: "s1", urls: [] },
    metadata,
  );
  expect(api.setExternalUrls).toHaveBeenCalledTimes(1);
});

test("links and prompts go through the session's installation", async () => {
  api.listPrompts.mockResolvedValueOnce([]);
  const urls = [{ label: "Run", url: "http://localhost:3000/run/wrun_01M26" }];
  await setLinearAgentSessionUrls({ installationName: "other", sessionId: "s2", urls }, metadata);
  expect(
    await listLinearAgentSessionPrompts({ installationName: "other", sessionId: "s2" }),
  ).toEqual([]);
  expect(linearAgentFor.mock.calls).toEqual([["other"], ["other"]]);
  expect(api.setExternalUrls).toHaveBeenCalledWith("s2", urls);
  expect(api.listPrompts).toHaveBeenCalledWith("s2");
});
