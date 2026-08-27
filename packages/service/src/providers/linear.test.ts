import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  createComment,
  fetchIssueSnapshot,
  getIssueParticipants,
  listCommentsSince,
  mention,
} from "./linear";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("LINEAR_API_KEY", "lin_test_key");
  vi.stubEnv("LINEAR_API_URL", "http://mock.test/graphql");
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const respond = (data: unknown) =>
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ data }), { status: 200 }),
  );

const lastRequest = () => {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init, body: JSON.parse(init.body as string) };
};

test("requests carry the API key and hit the override URL", async () => {
  respond({
    issue: { creator: { id: "u1", name: "salim" } },
    viewer: { id: "bot" },
  });
  await getIssueParticipants("68bc9696-35d5-442d-ab56-214c8cfefbec");
  const { url, init } = lastRequest();
  expect(url).toBe("http://mock.test/graphql");
  expect(new Headers(init.headers).get("authorization")).toBe("lin_test_key");
});

test("fetchIssueSnapshot asks for the snapshot fields in one round trip", async () => {
  respond({ issue: { id: "i1", identifier: "AGE-313" } });
  const issue = await fetchIssueSnapshot("issue-uuid");
  expect(issue.identifier).toBe("AGE-313");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const { url, body } = lastRequest();
  expect(url).toBe("http://mock.test/graphql");
  for (const field of [
    "branchName",
    "labels",
    "comments(last: 100)",
    "attachments",
    "children",
    "relations",
    "inverseRelations",
  ]) {
    expect(body.query).toContain(field);
  }
  expect(body.variables).toEqual({ id: "issue-uuid" });
});

test("createComment posts a commentCreate mutation with the body verbatim", async () => {
  respond({
    commentCreate: {
      success: true,
      comment: { id: "c1", createdAt: "2026-08-26T12:00:00Z" },
    },
  });
  const body = `${mention({ id: "u1", name: "salim" })} this run needs a human.`;
  const comment = await createComment("issue-uuid", body);
  expect(comment).toEqual({ id: "c1", createdAt: "2026-08-26T12:00:00Z" });
  const request = lastRequest().body;
  expect(request.query).toContain("commentCreate");
  expect(request.variables.input).toEqual({ issueId: "issue-uuid", body });
  expect(request.variables.input.body).toContain("@[salim](u1)");
});

test("listCommentsSince filters strictly after the cursor", async () => {
  respond({
    issue: {
      comments: {
        nodes: [
          {
            id: "c1",
            body: "old",
            createdAt: "2026-08-26T10:00:00Z",
            user: { id: "u1", name: "salim" },
          },
          {
            id: "c2",
            body: "new",
            createdAt: "2026-08-26T12:00:01Z",
            user: { id: "u1", name: "salim" },
          },
        ],
      },
    },
  });
  const comments = await listCommentsSince(
    "issue-uuid",
    "2026-08-26T12:00:00Z",
  );
  expect(comments.map((c) => c.id)).toEqual(["c2"]);
});

test("GraphQL errors and missing keys throw", async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ errors: [{ message: "boom" }] }), {
      status: 200,
    }),
  );
  await expect(getIssueParticipants("x")).rejects.toThrow("boom");

  vi.stubEnv("LINEAR_API_KEY", "");
  await expect(getIssueParticipants("x")).rejects.toThrow("LINEAR_API_KEY");
});
