// Called from inside "use step" functions and from the trigger-path
// preflight — never from a workflow body, where env reads and network are
// forbidden. LINEAR_API_URL override is a test seam.

export interface LinearUser {
  id: string;
  name: string;
}

export interface LinearComment {
  id: string;
  body: string;
  createdAt: string;
  user: LinearUser | null;
}

async function linearGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new Error("LINEAR_API_KEY is not set");
  }
  const url = process.env.LINEAR_API_URL ?? "https://api.linear.app/graphql";
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Linear API ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };
  const firstError = json.errors?.[0];
  if (firstError !== undefined) {
    throw new Error(`Linear GraphQL: ${firstError.message}`);
  }
  if (json.data === undefined) {
    throw new Error("Linear GraphQL: response carried no data");
  }
  return json.data;
}

// The preflight probe for LINEAR_API_KEY: the cheapest call that proves the
// key is both present and accepted.
export async function getViewer(): Promise<LinearUser> {
  const data = await linearGraphql<{ viewer: LinearUser }>(
    "query { viewer { id name } }",
    {},
  );
  return data.viewer;
}

export async function getIssueParticipants(
  issueId: string,
): Promise<{ creator: LinearUser | null; viewerId: string }> {
  const data = await linearGraphql<{
    issue: { creator: LinearUser | null };
    viewer: { id: string };
  }>(
    `query IssueParticipants($id: String!) {
      issue(id: $id) { creator { id name } }
      viewer { id }
    }`,
    { id: issueId },
  );
  return { creator: data.issue.creator, viewerId: data.viewer.id };
}

export async function createComment(
  issueId: string,
  body: string,
): Promise<{ id: string; createdAt: string }> {
  const data = await linearGraphql<{
    commentCreate: {
      success: boolean;
      comment: { id: string; createdAt: string };
    };
  }>(
    `mutation CreateComment($input: CommentCreateInput!) {
      commentCreate(input: $input) { success comment { id createdAt } }
    }`,
    { input: { issueId, body } },
  );
  if (!data.commentCreate.success) {
    throw new Error(`Linear commentCreate failed for issue ${issueId}`);
  }
  return data.commentCreate.comment;
}

export async function listCommentsSince(
  issueId: string,
  sinceIso: string,
): Promise<LinearComment[]> {
  const data = await linearGraphql<{
    issue: { comments: { nodes: LinearComment[] } };
  }>(
    // Unpaginated `last: 50` is an accepted cap: wake re-checks only ever
    // need the comments since the previous check.
    `query IssueComments($id: String!) {
      issue(id: $id) {
        comments(last: 50) { nodes { id body createdAt user { id name } } }
      }
    }`,
    { id: issueId },
  );
  return data.issue.comments.nodes.filter(
    (comment) => comment.createdAt > sinceIso,
  );
}

// Linear renders @-mentions in API-created comments as @[displayName](userId).
export function mention(user: LinearUser): string {
  return `@[${user.name}](${user.id})`;
}
