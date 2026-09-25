import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  createPullRequest,
  fetchPrCommitMessages,
  fetchPrSnapshot,
  fetchPrTitle,
  findOpenPullRequestByBranch,
  findOpenPullRequestsByHeadSha,
  markPrReady,
  mergePr,
  postPrComment,
  postPullRequestReview,
  replyToReviewThread,
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
  conversation?: unknown[];
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
    .mockResolvedValueOnce(json(fixture.conversation ?? []))
    .mockResolvedValueOnce(json({ check_runs: fixture.checkRuns ?? [] }))
    .mockResolvedValueOnce(json({ statuses: fixture.statuses ?? [] }));
}

const urls = () => fetchMock.mock.calls.map(([url]) => url as string);

test("findOpenPullRequestsByHeadSha returns matching open PRs using their base repos", async () => {
  fetchMock.mockResolvedValueOnce(
    json([
      {
        number: 41,
        state: "open",
        head: { sha: "status-sha" },
        base: { repo: { name: "api", owner: { login: "acme" } } },
      },
      {
        number: 42,
        state: "closed",
        head: { sha: "status-sha" },
        base: { repo: { name: "api", owner: { login: "acme" } } },
      },
      {
        number: 43,
        state: "open",
        head: { sha: "newer-sha" },
        base: { repo: { name: "api", owner: { login: "acme" } } },
      },
    ]),
  );

  await expect(
    findOpenPullRequestsByHeadSha({ owner: "fork-owner", repo: "fork" }, "status-sha"),
  ).resolves.toEqual([{ owner: "acme", repo: "api", number: 41 }]);
  expect(urls()).toEqual([
    "http://mock.test/github/repos/fork-owner/fork/commits/status-sha/pulls?per_page=100&page=1",
  ]);
});

function openPull(fixture: {
  number: number;
  state?: string;
  headRef?: string;
  headRepo?: string;
  baseRef?: string;
  baseRepo?: string;
}) {
  return {
    number: fixture.number,
    state: fixture.state ?? "open",
    html_url: `https://github.test/acme/api/pull/${fixture.number}`,
    head: {
      ref: fixture.headRef ?? "jigs/change",
      repo: { full_name: fixture.headRepo ?? "acme/api" },
    },
    base: {
      ref: fixture.baseRef ?? "main",
      repo: { full_name: fixture.baseRepo ?? "acme/api" },
    },
  };
}

test("findOpenPullRequestByBranch adopts the one open PR for the branch", async () => {
  fetchMock.mockResolvedValueOnce(json([openPull({ number: 41 })]));

  await expect(
    findOpenPullRequestByBranch({ owner: "acme", repo: "api" }, "jigs/change", "main"),
  ).resolves.toEqual({
    owner: "acme",
    repo: "api",
    number: 41,
    url: "https://github.test/acme/api/pull/41",
  });
  expect(urls()).toEqual([
    "http://mock.test/github/repos/acme/api/pulls?state=open&head=acme%3Ajigs%2Fchange&base=main&per_page=100&page=1",
  ]);
});

test("findOpenPullRequestByBranch skips every PR that is not this branch on this repo", async () => {
  fetchMock.mockResolvedValueOnce(
    json([
      openPull({ number: 41, state: "closed" }),
      openPull({ number: 42, headRepo: "contributor/api" }),
      // A sibling repository under the same owner: GitHub's head filter names
      // only the owner, so this comes back and must not be adopted.
      openPull({ number: 43, headRepo: "acme/api-fork" }),
      openPull({ number: 44, baseRepo: "acme/other" }),
      openPull({ number: 45, headRef: "jigs/other" }),
      openPull({ number: 46, baseRef: "release" }),
    ]),
  );

  await expect(
    findOpenPullRequestByBranch({ owner: "acme", repo: "api" }, "jigs/change", "main"),
  ).resolves.toBeNull();
});

test("findOpenPullRequestByBranch matches the repository whatever case GitHub reports", async () => {
  fetchMock.mockResolvedValueOnce(
    json([openPull({ number: 41, headRepo: "Acme/API", baseRepo: "Acme/API" })]),
  );

  await expect(
    findOpenPullRequestByBranch({ owner: "acme", repo: "api" }, "jigs/change", "main"),
  ).resolves.toMatchObject({ number: 41 });
});

test("findOpenPullRequestByBranch refuses to guess between several matches", async () => {
  fetchMock.mockResolvedValueOnce(json([openPull({ number: 41 }), openPull({ number: 42 })]));

  await expect(
    findOpenPullRequestByBranch({ owner: "acme", repo: "api" }, "jigs/change", "main"),
  ).rejects.toThrow("#41, #42");
});

test("fetchPrSnapshot shapes the PR, its reviews and the head sha", async () => {
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
    "http://mock.test/github/repos/acme/api/pulls/41/reviews?per_page=100&page=1",
    "http://mock.test/github/repos/acme/api/pulls/41/comments?per_page=100&page=1",
    "http://mock.test/github/repos/acme/api/issues/41/comments?per_page=100&page=1",
    "http://mock.test/github/repos/acme/api/commits/head-sha-1/check-runs?per_page=100",
    "http://mock.test/github/repos/acme/api/commits/head-sha-1/status?per_page=100",
  ]);
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(new Headers(init.headers).get("authorization")).toBe("Bearer gh_test_token");
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
        updated_at: "2026-08-26T12:00:00Z",
      },
      {
        id: 901,
        in_reply_to_id: 900,
        body: "because order matters",
        user: { login: "jigs-bot" },
        path: "src/gate.ts",
        line: 12,
        created_at: "2026-08-26T12:05:00Z",
        updated_at: "2026-08-26T12:05:00Z",
      },
      {
        id: 902,
        body: "typo",
        user: { login: "reviewer" },
        path: "README.md",
        line: null,
        created_at: "2026-08-26T12:06:00Z",
        updated_at: "2026-08-26T12:06:00Z",
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

test("check runs collapse to red, green, pending, and none with no CI at all", async () => {
  const run = (overrides: Record<string, unknown>) => ({
    name: "build",
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
    checkRuns: [run({}), run({ name: "test", conclusion: null })],
  });
  expect((await fetchPrSnapshot(pr)).ci).toBe("pending");

  // A repo with no CI must never escalate, so zero runs is neither green nor red.
  fetchMock.mockReset();
  stubSnapshot({ checkRuns: [] });
  const none = await fetchPrSnapshot(pr);
  expect(none.ci).toBe("none");
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

  // Two reports of one context read as two builds, so the red one stands
  // whichever order they arrive in.
  for (const pair of [
    [status({}), status({ state: "failure" })],
    [status({ state: "failure" }), status({})],
  ]) {
    fetchMock.mockReset();
    stubSnapshot({ statuses: pair });
    expect((await fetchPrSnapshot(pr)).ci).toBe("red");
  }

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
        conclusion: "success",
        html_url: "http://ci.test/1",
      },
    ],
    statuses: [{ context: "build", state: "failure", target_url: "http://cb.test/1" }],
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
        conclusion: "failure",
        html_url: "http://ci.test/1",
      },
    ],
    statuses: [{ context: "build", state: "success", target_url: "http://cb.test/1" }],
  });
  expect((await fetchPrSnapshot(pr)).failingChecks).toEqual([
    { name: "lint", conclusion: "failure", url: "http://ci.test/1" },
  ]);
});

test("one context on both surfaces counts once, as the check run", async () => {
  const run = (overrides: Record<string, unknown>) => ({
    name: "build",
    conclusion: "success",
    html_url: "http://ci.test/1",
    ...overrides,
  });

  stubSnapshot({
    checkRuns: [run({ conclusion: "failure" })],
    statuses: [{ context: "build", state: "success", target_url: "http://cb.test/1" }],
  });
  const red = await fetchPrSnapshot(pr);
  expect(red.ci).toBe("red");
  expect(red.failingChecks).toEqual([
    { name: "build", conclusion: "failure", url: "http://ci.test/1" },
  ]);

  fetchMock.mockReset();
  stubSnapshot({
    checkRuns: [run({})],
    statuses: [{ context: "build", state: "failure", target_url: "http://cb.test/1" }],
  });
  const green = await fetchPrSnapshot(pr);
  expect(green.ci).toBe("green");
  expect(green.failingChecks).toEqual([]);
});

test("two check runs of one name are two builds, and neither hides the other", async () => {
  const run = (overrides: Record<string, unknown>) => ({
    name: "build",
    conclusion: "success",
    html_url: "http://ci.test/1",
    ...overrides,
  });
  const failed = run({ conclusion: "failure", html_url: "http://ci.test/2" });

  for (const checkRuns of [
    [failed, run({})],
    [run({}), failed],
  ]) {
    fetchMock.mockReset();
    stubSnapshot({ checkRuns });
    const red = await fetchPrSnapshot(pr);
    expect(red.ci).toBe("red");
    expect(red.failingChecks).toEqual([
      { name: "build", conclusion: "failure", url: "http://ci.test/2" },
    ]);
  }

  for (const checkRuns of [
    [run({ conclusion: null }), run({})],
    [run({}), run({ conclusion: null })],
  ]) {
    fetchMock.mockReset();
    stubSnapshot({ checkRuns });
    expect((await fetchPrSnapshot(pr)).ci).toBe("pending");
  }
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
  expect(url).toBe("http://mock.test/github/repos/acme/api/pulls/41/comments/900/replies");
  expect(init.method).toBe("POST");
  expect(JSON.parse(String(init.body))).toEqual({ body: "fixed in a2b3c4d" });
  expect(new Headers(init.headers).get("content-type")).toBe("application/json");
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

test.each([
  ["comment", "COMMENT"],
  ["approve", "APPROVE"],
  ["request-changes", "REQUEST_CHANGES"],
] as const)("a %s review maps to GitHub's %s event", async (event, githubEvent) => {
  fetchMock.mockResolvedValueOnce(json({ id: 970 }));

  await expect(postPullRequestReview(pr, { event, body: "Summary" })).resolves.toEqual({ id: 970 });

  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("http://mock.test/github/repos/acme/api/pulls/41/reviews");
  expect(init.method).toBe("POST");
  expect(JSON.parse(String(init.body))).toEqual({ event: githubEvent, body: "Summary" });
});

test("a review preserves inline comment order and anchors comments to the head side", async () => {
  fetchMock.mockResolvedValueOnce(json({ id: 971 }));
  await postPullRequestReview(pr, {
    event: "comment",
    body: "Two notes",
    comments: [
      { path: "src/first.ts", line: 4, body: "First" },
      { path: "src/second.ts", line: 9, body: "Second" },
    ],
  });

  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(JSON.parse(String(init.body))).toEqual({
    event: "COMMENT",
    body: "Two notes",
    comments: [
      { path: "src/first.ts", line: 4, side: "RIGHT", body: "First" },
      { path: "src/second.ts", line: 9, side: "RIGHT", body: "Second" },
    ],
  });
});

test("a review with an empty comments array omits comments from the request", async () => {
  fetchMock.mockResolvedValueOnce(json({ id: 972 }));
  await postPullRequestReview(pr, { event: "comment", body: "Summary", comments: [] });

  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(JSON.parse(String(init.body))).toEqual({ event: "COMMENT", body: "Summary" });
});

test("createPullRequest posts its fields and passes through GitHub's number and URL", async () => {
  fetchMock.mockResolvedValueOnce(
    json({ number: 41, html_url: "https://github.example/acme/api/pull/41" }),
  );
  const created = await createPullRequest({
    owner: "acme",
    repo: "api",
    head: "salimhamed/age-316",
    base: "main",
    title: "AGE-316 Review loop jig",
    body: "the brief",
  });

  expect(created).toEqual({
    number: 41,
    html_url: "https://github.example/acme/api/pull/41",
  });
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

test("createPullRequest forwards draft when supplied", async () => {
  fetchMock.mockResolvedValueOnce(
    json({ number: 42, html_url: "https://github.example/acme/api/pull/42" }),
  );
  await createPullRequest({
    owner: "acme",
    repo: "api",
    head: "draft",
    base: "main",
    title: "Draft",
    body: "work in progress",
    draft: true,
  });
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(JSON.parse(String(init.body))).toMatchObject({ draft: true });
});

test("markPrReady resolves the REST node id and sends the GraphQL mutation", async () => {
  fetchMock
    .mockResolvedValueOnce(json({ node_id: "PR_node" }))
    .mockResolvedValueOnce(json({ data: {} }));

  await expect(markPrReady(pr)).resolves.toBeUndefined();

  expect(urls()).toEqual([
    "http://mock.test/github/repos/acme/api/pulls/41",
    "http://mock.test/github/graphql",
  ]);
  const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
  expect(init.method).toBe("POST");
  expect(JSON.parse(String(init.body))).toMatchObject({
    query: expect.stringContaining("markPullRequestReadyForReview"),
    variables: { pullRequestId: "PR_node" },
  });
});

test("markPrReady turns GraphQL errors into a GitHub API failure", async () => {
  fetchMock
    .mockResolvedValueOnce(json({ node_id: "PR_node" }))
    .mockResolvedValueOnce(json({ errors: [{ message: "Pull request cannot be marked ready" }] }));

  await expect(markPrReady(pr)).rejects.toMatchObject({
    status: 200,
    body: "Pull request cannot be marked ready",
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
  const merged = await mergePr(pr, {
    title: "AGE-316 Review loop jig",
    expectedHeadSha: "approved-head",
    method: "squash",
    message: "Co-authored-by: Salim Hamed <salim@example.com>",
  });

  expect(merged).toEqual({ merged: true, sha: "merge-sha" });
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("http://mock.test/github/repos/acme/api/pulls/41/merge");
  expect(init.method).toBe("PUT");
  expect(JSON.parse(String(init.body))).toEqual({
    merge_method: "squash",
    commit_title: "AGE-316 Review loop jig",
    commit_message: "Co-authored-by: Salim Hamed <salim@example.com>",
    sha: "approved-head",
  });
});

test("a rebase rewrites the commits, so it carries no merge message", async () => {
  fetchMock.mockResolvedValueOnce(json({ merged: true, sha: "merge-sha" }));
  await mergePr(pr, {
    title: "fix: search",
    expectedHeadSha: "approved-head",
    method: "rebase",
    message: "Co-authored-by: Salim Hamed <salim@example.com>",
  });
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(JSON.parse(String(init.body))).toEqual({
    merge_method: "rebase",
    sha: "approved-head",
  });
});

test("reads later review pages so a recent rejection is not hidden", async () => {
  fetchMock
    .mockResolvedValueOnce(json({ state: "open", merged: false, head: { sha: "head" } }))
    .mockResolvedValueOnce(
      json(
        Array.from({ length: 100 }, (_, id) => ({
          id,
          state: "APPROVED",
          body: "",
          user: { login: "person" },
          submitted_at: "1",
          commit_id: "head",
        })),
      ),
    )
    .mockResolvedValueOnce(
      json([
        {
          id: 101,
          state: "CHANGES_REQUESTED",
          body: "fix",
          user: { login: "person" },
          submitted_at: "2",
          commit_id: "head",
        },
      ]),
    )
    .mockResolvedValueOnce(json([]))
    .mockResolvedValueOnce(json([]))
    .mockResolvedValueOnce(json({ check_runs: [] }))
    .mockResolvedValueOnce(json({ statuses: [] }))
    .mockResolvedValueOnce(json({ login: "agent" }));
  const state = await fetchPrSnapshot(pr);
  expect(state.reviews).toHaveLength(101);
  expect(state.reviews.at(-1)).toMatchObject({ state: "CHANGES_REQUESTED", commitSha: "head" });
  expect(fetchMock.mock.calls[2]?.[0]).toContain("reviews?per_page=100&page=2");
});

test("conversation comments come back whole, with the version an edit changes", async () => {
  stubSnapshot({
    conversation: [
      {
        id: 5150,
        body: "one more thing",
        user: { login: "salim", type: "User" },
        created_at: "2026-09-13T10:00:00Z",
        updated_at: "2026-09-13T10:30:00Z",
      },
      {
        id: 5151,
        body: "coverage dropped",
        user: { login: "codecov[bot]", type: "Bot" },
        created_at: "2026-09-13T10:05:00Z",
        updated_at: "2026-09-13T10:05:00Z",
      },
    ],
  });

  const snapshot = await fetchPrSnapshot(pr);

  expect(snapshot.conversationComments).toEqual([
    {
      id: 5150,
      body: "one more thing",
      user: "salim",
      userType: "User",
      createdAt: "2026-09-13T10:00:00Z",
      updatedAt: "2026-09-13T10:30:00Z",
    },
    {
      id: 5151,
      body: "coverage dropped",
      user: "codecov[bot]",
      userType: "Bot",
      createdAt: "2026-09-13T10:05:00Z",
      updatedAt: "2026-09-13T10:05:00Z",
    },
  ]);
});

test("a full page of conversation comments is followed to the next page", async () => {
  const page = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: from + i,
      body: "note",
      user: { login: "salim" },
      created_at: "1",
      updated_at: "1",
    }));
  fetchMock
    .mockResolvedValueOnce(json({ state: "open", merged: false, head: { sha: "head" } }))
    .mockResolvedValueOnce(json([]))
    .mockResolvedValueOnce(json([]))
    .mockResolvedValueOnce(json(page(1, 100)))
    .mockResolvedValueOnce(json(page(101, 2)))
    .mockResolvedValueOnce(json({ check_runs: [] }))
    .mockResolvedValueOnce(json({ statuses: [] }))
    .mockResolvedValueOnce(json({ login: "agent" }));

  const snapshot = await fetchPrSnapshot(pr);

  expect(snapshot.conversationComments).toHaveLength(102);
  expect(fetchMock.mock.calls[4]?.[0]).toContain("issues/41/comments?per_page=100&page=2");
});

test("fetchPrCommitMessages reads the branch's own messages, paginated", async () => {
  fetchMock.mockResolvedValueOnce(
    json([{ commit: { message: "feat: one\n\nBREAKING CHANGE: moved." } }]),
  );
  expect(await fetchPrCommitMessages(pr)).toEqual(["feat: one\n\nBREAKING CHANGE: moved."]);
  expect(urls()[0]).toContain("/repos/acme/api/pulls/41/commits?per_page=100&page=1");
});
