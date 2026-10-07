import { beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  postActivity: vi.fn(),
  findActivity: vi.fn(),
  setExternalUrls: vi.fn(),
  listPrompts: vi.fn(),
}));
const linearAgentFor = vi.hoisted(() => vi.fn(() => api));
vi.mock("../../providers/linear-agent.ts", () => ({ linearAgentFor }));

const { listLinearAgentSessionPrompts, postLinearAgentActivity, setLinearAgentSessionUrls } =
  await import("./agent-sessions.ts");
const { stepPostingId } = await import("./needs-human-comments.ts");

const metadata = { workflowRunId: "wrun_01M26", workflowName: "chat", stepId: "step_01" };
const thought = { type: "thought", body: "Looking" } as const;
const posted = { id: "a1", createdAt: "2026-10-07T00:00:00.000Z" };

beforeEach(() => {
  vi.clearAllMocks();
});

test("an activity is posted through its installation under an id the step derives", async () => {
  api.postActivity.mockResolvedValueOnce(posted);
  const request = { installationName: "acme", sessionId: "s1", content: thought, ephemeral: true };

  expect(await postLinearAgentActivity(request, metadata)).toEqual(posted);

  expect(linearAgentFor).toHaveBeenCalledWith("acme");
  expect(api.postActivity).toHaveBeenCalledWith("s1", thought, {
    id: stepPostingId(metadata, "s1"),
    ephemeral: true,
  });
  expect(api.findActivity).not.toHaveBeenCalled();
});

test("a retry whose first post landed finds that activity instead of posting twice", async () => {
  api.postActivity.mockRejectedValueOnce(new Error("id already exists"));
  api.findActivity.mockResolvedValueOnce(posted);

  const result = await postLinearAgentActivity(
    { installationName: "acme", sessionId: "s1", content: thought },
    metadata,
  );

  expect(result).toEqual(posted);
  expect(api.findActivity).toHaveBeenCalledWith(stepPostingId(metadata, "s1"));
});

test("a post that failed and left nothing behind fails the step", async () => {
  api.postActivity.mockRejectedValueOnce(new Error("Linear is down"));
  api.findActivity.mockResolvedValueOnce(null);
  await expect(
    postLinearAgentActivity(
      { installationName: "acme", sessionId: "s1", content: thought },
      metadata,
    ),
  ).rejects.toThrow("Linear is down");
});

test("links and prompts go through the session's installation", async () => {
  api.listPrompts.mockResolvedValueOnce([]);
  const urls = [{ label: "Run", url: "http://localhost:3000/run/wrun_01M26" }];
  await setLinearAgentSessionUrls({ installationName: "other", sessionId: "s2", urls });
  expect(
    await listLinearAgentSessionPrompts({ installationName: "other", sessionId: "s2" }),
  ).toEqual([]);
  expect(linearAgentFor.mock.calls).toEqual([["other"], ["other"]]);
  expect(api.setExternalUrls).toHaveBeenCalledWith("s2", urls);
  expect(api.listPrompts).toHaveBeenCalledWith("s2");
});
