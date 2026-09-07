import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  createPullRequest,
  fetchPrSnapshot,
  fetchPrTitle,
  postPrComment,
  replyToReviewThread,
  squashMergePr,
} from "./github.ts";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GITHUB_TOKEN", "gh_test_token");
  vi.stubEnv("GITHUB_API_URL", "http://mock.test/github");
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const pr = { owner: "acme", repo: "api", number: 41 };

const json = (body: unknown) => new Response(JSON.stringify(body));

interface SnapshotFixture {
  pull?: Record<string, unknown>;
  reviews?: unknown[];
  comments?: unknown[];
  checkRuns?: unknown[];
  statuses?: unknown[];
}

// The six calls fetchPrSnapshot makes, in order.
function stubSnapshot(fixture: SnapshotFixture = {}): void {
  fetchMock
    .mockResolvedValueOnce(
      json({
        state: "open",
        merged: false,
        head: { sha: "head-sha-1" },
        ...fixture.pull,
      }),
    )
    .mockResolvedValueOnce(json(fixture.reviews ?? []))
    .mockResolvedValueOnce(json(fixture.comments ?? []))
    .mockResolvedValueOnce(json({ check_runs: fixture.checkRuns ?? [] }))
    .mockResolvedValueOnce(json({ statuses: fixture.statuses ?? [] }))
    .mockResolvedValueOnce(json({ login: "jigs-bot" }));
}

const urls = () => fetchMock.mock.calls.map(([url]) => url as string);

test("fetchPrSnapshot shapes the PR, its reviews, the head sha and the viewer", async () => {
  stubSnapshot({
    reviews: [
      {
        id: 7,
        state: "APPROVED",
        body: null,
        user: { login: "reviewer" },
        submitted_at: "2026-08-26T12:00:00Z",
      },
    ],
  });

  const snapshot = await fetchPrSnapshot(pr);

  expect(snapshot.state).toBe("open");
  expect(snapshot.merged).toBe(false);
  expect(snapshot.headSha).toBe("head-sha-1");
  expect(snapshot.viewer).toBe("jigs-bot");
  expect(snapshot.reviews).toEqual([
    {
      id: 7,
      state: "APPROVED",
      body: "",
      user: "reviewer",
      submittedAt: "2026-08-26T12:00:00Z",
    },
  ]);

  expect(urls()).toEqual([
    "http://mock.test/github/repos/acme/api/pulls/41",
    "http://mock.test/github/repos/acme/api/pulls/41/reviews?per_page=100",
    "http://mock.test/github/repos/acme/api/pulls/41/comments?per_page=100",
    "http://mock.test/github/repos/acme/api/commits/head-sha-1/check-runs?per_page=100",
    "http://mock.test/github/repos/acme/api/commits/head-sha-1/status?per_page=100",
    "http://mock.test/github/user",
  ]);
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(new Headers(init.headers).get("authorization")).toBe(
    "Bearer gh_test_token",
  );
});

test("review comments group into threads by in_reply_to_id", async () => {
  stubSnapshot({
    comments: [
      {
        id: 900,
        body: "why not a set here?",
        user: { login: "reviewer" },
        path: "src/gate.ts",
        line: 12,
        created_at: "2026-08-26T12:00:00Z",
      },
      {
        id: 901,
        in_reply_to_id: 900,
        body: "because order matters",
        user: { login: "jigs-bot" },
        path: "src/gate.ts",
        line: 12,
        created_at: "2026-08-26T12:05:00Z",
      },
      {
        id: 902,
        body: "typo",
        user: { login: "reviewer" },
        path: "README.md",
        line: null,
        created_at: "2026-08-26T12:06:00Z",
      },
    ],
  });

  const { reviewThreads } = await fetchPrSnapshot(pr);

  expect(reviewThreads).toEqual([
    {
      rootId: 900,
      path: "src/gate.ts",
      line: 12,
      comments: [
        expect.objectContaining({ id: 900, rootId: 900, user: "reviewer" }),
        expect.objectContaining({ id: 901, rootId: 900, user: "jigs-bot" }),
      ],
    },
    {
      rootId: 902,
      path: "README.md",
      line: null,
      comments: [expect.objectContaining({ id: 902, body: "typo" })],
    },
  ]);
});

test("check runs collapse to red, green, pending, and pending again with no CI at all", async () => {
  const run = (overrides: Record<string, unknown>) => ({
    name: "build",
    status: "completed",
    conclusion: "success",
    html_url: "http://ci.test/1",
    ...overrides,
  });

  stubSnapshot({
    checkRuns: [run({}), run({ name: "test", conclusion: "failure" })],
  });
  const red = await fetchPrSnapshot(pr);
  expect(red.ci).toBe("red");
  expect(red.failingChecks).toEqual([
    { name: "test", conclusion: "failure", url: "http://ci.test/1" },
  ]);

  fetchMock.mockReset();
  stubSnapshot({ checkRuns: [run({})] });
  expect((await fetchPrSnapshot(pr)).ci).toBe("green");

  fetchMock.mockReset();
  stubSnapshot({
    checkRuns: [run({}), run({ status: "in_progress", conclusion: null })],
  });
  expect((await fetchPrSnapshot(pr)).ci).toBe("pending");

  // A repo with no CI must never escalate, so zero runs is never green.
  fetchMock.mockReset();
  stubSnapshot({ checkRuns: [] });
  const none = await fetchPrSnapshot(pr);
  expect(none.ci).toBe("pending");
  expect(none.failingChecks).toEqual([]);
});

test("commit statuses join the check runs the gate and fixCi read", async () => {
  const status = (overrides: Record<string, unknown>) => ({
    context: "AWS CodeBuild us-west-2 (Forge-CI-Beta)",
    state: "success",
    target_url: "http://codebuild.test/1",
    ...overrides,
  });

  stubSnapshot({ statuses: [status({}), status({ context: "e2e" })] });
  expect((await fetchPrSnapshot(pr)).ci).toBe("green");

  fetchMock.mockReset();
  stubSnapshot({ statuses: [status({}), status({ state: "failure" })] });
  const failed = await fetchPrSnapshot(pr);
  expect(failed.ci).toBe("red");
  expect(failed.failingChecks).toEqual([
    {
      name: "AWS CodeBuild us-west-2 (Forge-CI-Beta)",
      conclusion: "failure",
      url: "http://codebuild.test/1",
    },
  ]);

  // An errored status is as red as a failed one.
  fetchMock.mockReset();
  stubSnapshot({ statuses: [status({ state: "error" })] });
  expect((await fetchPrSnapshot(pr)).ci).toBe("red");

  fetchMock.mockReset();
  stubSnapshot({ statuses: [status({ state: "pending" })] });
  expect((await fetchPrSnapshot(pr)).ci).toBe("pending");

  // A state jigs cannot read must never pass for green.
  fetchMock.mockReset();
  stubSnapshot({ statuses: [status({ state: "queued" })] });
  expect((await fetchPrSnapshot(pr)).ci).toBe("pending");

  fetchMock.mockReset();
  stubSnapshot({ statuses: [status({ state: "failure", target_url: null })] });
  expect((await fetchPrSnapshot(pr)).failingChecks).toEqual([
    {
      name: "AWS CodeBuild us-west-2 (Forge-CI-Beta)",
      conclusion: "failure",
      url: "",
    },
  ]);
});

test("a green check run does not hide a red status, or the reverse", async () => {
  stubSnapshot({
    checkRuns: [
      {
        name: "lint",
        status: "completed",
        conclusion: "success",
        html_url: "http://ci.test/1",
      },
    ],
    statuses: [
      { context: "build", state: "failure", target_url: "http://cb.test/1" },
    ],
  });
  const statusRed = await fetchPrSnapshot(pr);
  expect(statusRed.ci).toBe("red");
  expect(statusRed.failingChecks).toEqual([
    { name: "build", conclusion: "failure", url: "http://cb.test/1" },
  ]);

  fetchMock.mockReset();
  stubSnapshot({
    checkRuns: [
      {
        name: "lint",
        status: "completed",
        conclusion: "failure",
        html_url: "http://ci.test/1",
      },
    ],
    statuses: [
      { context: "build", state: "success", target_url: "http://cb.test/1" },
    ],
  });
  expect((await fetchPrSnapshot(pr)).failingChecks).toEqual([
    { name: "lint", conclusion: "failure", url: "http://ci.test/1" },
  ]);
});

test("one name on both surfaces counts once, as the worse of the two", async () => {
  const run = (overrides: Record<string, unknown>) => ({
    name: "build",
    status: "completed",
    conclusion: "success",
    html_url: "http://ci.test/1",
    ...overrides,
  });

  stubSnapshot({
    checkRuns: [run({ conclusion: "failure" })],
    statuses: [
      { context: "build", state: "success", target_url: "http://cb.test/1" },
    ],
  });
  const runRed = await fetchPrSnapshot(pr);
  expect(runRed.ci).toBe("red");
  expect(runRed.failingChecks).toEqual([
    { name: "build", conclusion: "failure", url: "http://ci.test/1" },
  ]);

  // The inverse: a green check run must not bury the status that failed.
  fetchMock.mockReset();
  stubSnapshot({
    checkRuns: [run({})],
    statuses: [
      { context: "build", state: "failure", target_url: "http://cb.test/1" },
    ],
  });
  const statusRed = await fetchPrSnapshot(pr);
  expect(statusRed.ci).toBe("red");
  expect(statusRed.failingChecks).toEqual([
    { name: "build", conclusion: "failure", url: "http://cb.test/1" },
  ]);

  // Nor the one still running.
  fetchMock.mockReset();
  stubSnapshot({
    checkRuns: [run({})],
    statuses: [
      { context: "build", state: "pending", target_url: "http://cb.test/1" },
    ],
  });
  expect((await fetchPrSnapshot(pr)).ci).toBe("pending");
});

test("a non-2xx response throws with the path named", async () => {
  fetchMock.mockResolvedValueOnce(new Response("nope", { status: 404 }));
  await expect(fetchPrSnapshot(pr)).rejects.toThrow("/repos/acme/api/pulls/41");
});

test("a missing GITHUB_TOKEN throws before any request", async () => {
  vi.stubEnv("GITHUB_TOKEN", "");
  await expect(fetchPrSnapshot(pr)).rejects.toThrow("GITHUB_TOKEN");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a threaded reply posts to the thread root's replies endpoint", async () => {
  fetchMock.mockResolvedValueOnce(json({ id: 950 }));
  await replyToReviewThread(pr, 900, "fixed in a2b3c4d");

  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe(
    "http://mock.test/github/repos/acme/api/pulls/41/comments/900/replies",
  );
  expect(init.method).toBe("POST");
  expect(JSON.parse(String(init.body))).toEqual({ body: "fixed in a2b3c4d" });
  expect(new Headers(init.headers).get("content-type")).toBe(
    "application/json",
  );
});

test("a PR comment posts to the issue comments endpoint", async () => {
  fetchMock.mockResolvedValueOnce(json({ id: 960 }));
  await postPrComment(pr, "@reviewer CI is still red");

  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("http://mock.test/github/repos/acme/api/issues/41/comments");
  expect(init.method).toBe("POST");
  expect(JSON.parse(String(init.body))).toEqual({
    body: "@reviewer CI is still red",
  });
});

test("createPullRequest posts head, base, title and body and returns the number", async () => {
  fetchMock.mockResolvedValueOnce(json({ number: 41 }));
  const created = await createPullRequest({
    owner: "acme",
    repo: "api",
    head: "salimhamed/age-316",
    base: "main",
    title: "AGE-316 Review loop jig",
    body: "the brief",
  });

  expect(created).toEqual({ number: 41 });
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("http://mock.test/github/repos/acme/api/pulls");
  expect(init.method).toBe("POST");
  expect(JSON.parse(String(init.body))).toEqual({
    head: "salimhamed/age-316",
    base: "main",
    title: "AGE-316 Review loop jig",
    body: "the brief",
  });
});

test("the PR title is read back from GitHub, not remembered", async () => {
  fetchMock.mockResolvedValueOnce(json({ title: "fix(gate): retry on 502" }));

  expect(await fetchPrTitle(pr)).toBe("fix(gate): retry on 502");
  const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("http://mock.test/github/repos/acme/api/pulls/41");
});

test("a squash merge PUTs merge_method squash with the commit title", async () => {
  fetchMock.mockResolvedValueOnce(json({ merged: true, sha: "merge-sha" }));
  const merged = await squashMergePr(pr, "AGE-316 Review loop jig");

  expect(merged).toEqual({ merged: true, sha: "merge-sha" });
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("http://mock.test/github/repos/acme/api/pulls/41/merge");
  expect(init.method).toBe("PUT");
  expect(JSON.parse(String(init.body))).toEqual({
    merge_method: "squash",
    commit_title: "AGE-316 Review loop jig",
  });
});
