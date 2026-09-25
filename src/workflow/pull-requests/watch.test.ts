import { beforeEach, expect, test, vi } from "vitest";
import type { PullRequestSnapshot } from "./snapshot.ts";
import { watchPullRequest } from "./watch.ts";

const { createHook, hook } = vi.hoisted(() => ({
  createHook: vi.fn(),
  hook: {
    awaited: 0,
    disposed: 0,
    conflict: null as { runId: string } | null,
    wake: null as (() => void) | null,
  },
}));
vi.mock("workflow", () => ({ createHook }));
beforeEach(() => {
  Object.assign(hook, { awaited: 0, disposed: 0, conflict: null, wake: null });
  createHook.mockReset();
  createHook.mockImplementation(() => ({
    getConflict: async () => hook.conflict,
    // biome-ignore lint/suspicious/noThenProperty: the SDK's Hook is a thenable
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
      hook.awaited += 1;
      return new Promise<unknown>((wake) => {
        hook.wake = () => wake(undefined);
      }).then(resolve, reject);
    },
    dispose: () => {
      hook.disposed += 1;
    },
  }));
});

const pr = { owner: "Acme", repo: "App", number: 7 };
const snapshot = (patch: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
  state: "open",
  merged: false,
  draft: false,
  mergeState: "clean",
  labels: [],
  mergeCommitSha: null,
  headSha: "a",
  reviews: [],
  reviewThreads: [],
  conversationComments: [],
  ci: "pending",
  failingChecks: [],
  ...patch,
});
const comment = {
  id: 1,
  body: "Added the test",
  user: "operator",
  userType: "User",
  createdAt: "2026-09-25T12:00:00Z",
  updatedAt: "2026-09-25T12:00:00Z",
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("reads immediately and releases the existing PR token on early exit", async () => {
  const first = snapshot({ conversationComments: [comment] });
  const fetch = vi.fn(async () => first);
  for await (const state of watchPullRequest(pr, fetch)) {
    expect(state).toEqual(first);
    break;
  }
  expect(createHook).toHaveBeenCalledWith({ token: "github:pr:acme/app#7" });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(pr);
  expect(hook.awaited).toBe(0);
  expect(hook.disposed).toBe(1);
});

test("duplicate notifications, fetch metadata and collection ordering do not yield", async () => {
  const first = snapshot({
    labels: ["b", "a"],
    conversationComments: [comment, { ...comment, id: 2 }],
  });
  const same = {
    ...first,
    labels: ["a", "b"],
    conversationComments: [...first.conversationComments].reverse(),
    fetchedAt: "later",
  };
  const closed = snapshot({ state: "closed", merged: true });
  const states = [first, same, same, closed];
  const fetch = vi.fn(async () => states.shift() ?? closed);
  const watcher = watchPullRequest(pr, fetch);
  expect((await watcher.next()).value).toEqual(first);
  const next = watcher.next();
  await flush();
  for (let index = 0; index < 2; index += 1) {
    hook.wake?.();
    await flush();
    expect(await Promise.race([next, Promise.resolve("waiting")])).toBe("waiting");
  }
  hook.wake?.();
  expect((await next).value).toEqual(closed);
  expect(await watcher.next()).toEqual({ done: true, value: undefined });
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(hook.disposed).toBe(1);
});

test.each([
  ["head", { headSha: "b" }],
  ["checks", { ci: "red", failingChecks: [{ name: "test", conclusion: "failure", url: "url" }] }],
  ["unmarked agent comment", { conversationComments: [comment, { ...comment, id: 3 }] }],
  [
    "edited comment",
    { conversationComments: [{ ...comment, body: "Actually, more work is needed" }] },
  ],
  [
    "review",
    {
      reviews: [
        { id: 2, state: "APPROVED", body: "", user: "person", submittedAt: "now", commitSha: "a" },
      ],
    },
  ],
  ["label", { labels: ["approved"] }],
  ["mergeability", { mergeState: "blocked" }],
] satisfies [string, Partial<PullRequestSnapshot>][])(
  "yields changed %s facts without judging them",
  async (_name, patch) => {
    const first = snapshot();
    const changed = snapshot(patch);
    const fetch = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(changed);
    const watcher = watchPullRequest(pr, fetch);
    await watcher.next();
    const next = watcher.next();
    await flush();
    hook.wake?.();
    expect((await next).value).toEqual(changed);
    await watcher.return();
    expect(hook.disposed).toBe(1);
  },
);

test.each([true, false])(
  "an already closed PR yields once and ends (merged=%s)",
  async (merged) => {
    const closed = snapshot({ state: "closed", merged });
    const watcher = watchPullRequest(pr, async () => closed);
    expect(await watcher.next()).toEqual({ done: false, value: closed });
    expect(await watcher.next()).toEqual({ done: true, value: undefined });
    expect(hook.awaited).toBe(0);
    expect(hook.disposed).toBe(1);
  },
);

test("conflicts fail before fetching, and dispose the hook", async () => {
  hook.conflict = { runId: "wrun_owner" };
  const fetch = vi.fn(async () => snapshot());
  await expect(watchPullRequest(pr, fetch).next()).rejects.toThrow(
    "is already claimed by run wrun_owner",
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(hook.disposed).toBe(1);
});

test("reader failures dispose the hook", async () => {
  const watcher = watchPullRequest(pr, async () => {
    throw new Error("GitHub unavailable");
  });
  await expect(watcher.next()).rejects.toThrow("GitHub unavailable");
  expect(hook.disposed).toBe(1);
});
