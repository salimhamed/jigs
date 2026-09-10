// These read env and hit the network, so a caller must reach them only from
// inside a "use step" function or from a route handler (the trigger's ticket
// lookup, the run-ref resolver) — never from a workflow body, where both are
// forbidden. LINEAR_API_URL is a test seam.

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

export interface LinearWebhook {
  url: string;
  enabled: boolean;
}

export async function listWebhooks(): Promise<LinearWebhook[]> {
  const data = await linearGraphql<{
    webhooks: { nodes: LinearWebhook[] };
  }>("query { webhooks { nodes { url enabled } } }", {});
  return data.webhooks.nodes;
}

export interface LinearIssueRef {
  id: string;
  identifier: string;
}

export async function resolveIssueRef(ticket: string): Promise<LinearIssueRef> {
  const data = await linearGraphql<{ issue: LinearIssueRef | null }>(
    `query IssueRef($id: String!) {
      issue(id: $id) { id identifier }
    }`,
    { id: ticket },
  );
  if (data.issue === null) throw new Error(`Linear issue not found: ${ticket}`);
  return data.issue;
}

export async function getIssueParticipants(
  issueId: string,
): Promise<{ creator: LinearUser | null }> {
  const data = await linearGraphql<{ issue: { creator: LinearUser | null } }>(
    `query IssueParticipants($id: String!) {
      issue(id: $id) { creator { id name } }
    }`,
    { id: issueId },
  );
  return { creator: data.issue.creator };
}

interface RawIssueRef {
  id: string;
  identifier: string;
  title: string;
}

export interface RawIssueSnapshot {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  branchName: string;
  state: { name: string };
  labels: { nodes: Array<{ name: string }> };
  comments: { nodes: LinearComment[] };
  attachments: { nodes: Array<{ title: string; url: string }> };
  children: { nodes: RawIssueRef[] };
  relations: { nodes: Array<{ type: string; relatedIssue: RawIssueRef }> };
  inverseRelations: { nodes: Array<{ type: string; issue: RawIssueRef }> };
}

// The whole snapshot in one round trip, so every step in an activation reads
// a copy taken at one instant. Unpaginated `last: 100` on comments is an
// accepted cap: a ticket with more than 100 comments loses its oldest ones
// from the reviewed copy.
export async function fetchIssueSnapshot(
  issueId: string,
): Promise<RawIssueSnapshot> {
  const data = await linearGraphql<{ issue: RawIssueSnapshot }>(
    `query IssueSnapshot($id: String!) {
      issue(id: $id) {
        id identifier title description url branchName
        state { name }
        labels { nodes { name } }
        comments(last: 100) { nodes { id body createdAt user { id name } } }
        attachments { nodes { title url } }
        children { nodes { id identifier title } }
        relations { nodes { type relatedIssue { id identifier title } } }
        inverseRelations { nodes { type issue { id identifier title } } }
      }
    }`,
    { id: issueId },
  );
  return data.issue;
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

interface RawProject {
  id: string;
  teams: { nodes: Array<{ id: string }> };
}

const PROJECT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A Linear project URL ends in its slugId, so accept that as well as the UUID.
async function resolveProject(ref: string): Promise<RawProject> {
  if (PROJECT_UUID.test(ref)) {
    const data = await linearGraphql<{ project: RawProject | null }>(
      `query Project($ref: String!) {
        project(id: $ref) { id teams { nodes { id } } }
      }`,
      { ref },
    );
    if (data.project === null) {
      throw new Error(`Linear project not found: ${ref}`);
    }
    return data.project;
  }
  const data = await linearGraphql<{ projects: { nodes: RawProject[] } }>(
    `query ProjectBySlugId($ref: String!) {
      projects(filter: { slugId: { eq: $ref } }, first: 1) {
        nodes { id teams { nodes { id } } }
      }
    }`,
    { ref },
  );
  const project = data.projects.nodes[0];
  if (project === undefined) {
    throw new Error(`Linear project not found: ${ref}`);
  }
  return project;
}

export async function createIssueInProject(input: {
  project: string;
  title: string;
  description: string;
}): Promise<{ id: string; identifier: string; url: string }> {
  const project = await resolveProject(input.project);
  const team = project.teams.nodes[0];
  if (team === undefined) {
    throw new Error(`Linear project has no team: ${input.project}`);
  }
  const data = await linearGraphql<{
    issueCreate: {
      success: boolean;
      issue: { id: string; identifier: string; url: string };
    };
  }>(
    `mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { id identifier url } }
    }`,
    {
      input: {
        teamId: team.id,
        projectId: project.id,
        title: input.title,
        description: input.description,
      },
    },
  );
  if (!data.issueCreate.success) {
    throw new Error(`Linear issueCreate failed for project ${input.project}`);
  }
  return data.issueCreate.issue;
}

interface RawIssueMatch {
  id: string;
  identifier: string;
  url: string;
  title: string;
  description: string | null;
  state: { name: string };
  trashed: boolean | null;
}

export interface LinearIssueMatch {
  id: string;
  identifier: string;
  url: string;
  title: string;
  description: string;
  state: string;
}

export async function findIssueInProject(input: {
  project: string;
  titlePrefix: string;
}): Promise<LinearIssueMatch | null> {
  const project = await resolveProject(input.project);
  const data = await linearGraphql<{ issues: { nodes: RawIssueMatch[] } }>(
    // Unpaginated `first: 5` is an accepted cap: enough unless humans trash
    // five same-prefix issues in one bucket.
    `query FindIssue($projectId: ID!, $prefix: String!) {
      issues(filter: { project: { id: { eq: $projectId } }, title: { startsWith: $prefix } }, orderBy: createdAt, first: 5) {
        nodes { id identifier url title description state { name } trashed }
      }
    }`,
    { projectId: project.id, prefix: input.titlePrefix },
  );
  // `orderBy: createdAt` sorts newest first, so the first live node is the
  // newest match. Live issues carry `trashed: null` rather than false.
  const issue = data.issues.nodes.find((node) => node.trashed !== true);
  if (issue === undefined) return null;
  return {
    id: issue.id,
    identifier: issue.identifier,
    url: issue.url,
    title: issue.title,
    description: issue.description ?? "",
    state: issue.state.name,
  };
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
