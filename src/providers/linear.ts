// These read env and hit the network, so a caller must reach them only from
// inside a "use step" function or from a route handler (the trigger's ticket
// lookup, the run-ref resolver) — never from a workflow body, where both are
// forbidden.

import { LINEAR_API_URL, linearAuthFor } from "./linear-auth.ts";

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

interface GraphqlBody<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

interface GraphqlReply<T> {
  res: Response;
  text: string;
  body: GraphqlBody<T> | undefined;
}

function parseBody<T>(text: string): GraphqlBody<T> | undefined {
  try {
    return JSON.parse(text) as GraphqlBody<T>;
  } catch {
    return undefined;
  }
}

// Linear names a rejected credential in the errors array as well as with a
// 401, so either one retires a minted token.
function rejectedCredential(reply: GraphqlReply<unknown>): boolean {
  return (
    reply.res.status === 401 ||
    (reply.body?.errors?.some((error) => error.extensions?.code === "AUTHENTICATION_ERROR") ??
      false)
  );
}

async function linearGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const auth = linearAuthFor();
  const post = async (): Promise<GraphqlReply<T>> => {
    const res = await fetch(LINEAR_API_URL(), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: await auth.authorization() },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    return { res, text, body: parseBody<T>(text) };
  };
  let reply = await post();
  // A minted token outlived its welcome; a personal key would only fail again.
  if (auth.identity.mode === "app" && rejectedCredential(reply)) {
    auth.invalidate();
    reply = await post();
  }
  const { res, text, body } = reply;
  if (!res.ok) {
    throw new Error(`Linear API ${res.status}: ${text}`);
  }
  if (body === undefined) {
    throw new Error(`Linear API ${res.status}: response was not JSON: ${text}`);
  }
  const firstError = body.errors?.[0];
  if (firstError !== undefined) {
    throw new Error(`Linear GraphQL: ${firstError.message}`);
  }
  if (body.data === undefined) {
    throw new Error("Linear GraphQL: response carried no data");
  }
  return body.data;
}

// The preflight probe for the Linear identity: the cheapest call that proves
// the credential is both present and accepted, and names who jigs is.
export async function getViewer(): Promise<LinearUser> {
  const data = await linearGraphql<{ viewer: LinearUser }>("query { viewer { id name } }", {});
  return data.viewer;
}

/** The active Linear user with this email, or null when none has it. */
export async function findUserByEmail(email: string): Promise<LinearUser | null> {
  // Linear leaves deactivated users out unless includeDisabled is set, so one
  // who left the workspace reads as nobody.
  const data = await linearGraphql<{ users: { nodes: LinearUser[] } }>(
    `query UserByEmail($email: String!) {
      users(filter: { email: { eqIgnoreCase: $email } }, first: 1) { nodes { id name } }
    }`,
    { email },
  );
  return data.users.nodes[0] ?? null;
}

export interface LinearWebhook {
  url: string;
  enabled: boolean;
}

export async function listWebhooks(): Promise<LinearWebhook[]> {
  const webhooks: LinearWebhook[] = [];
  let after: string | null = null;
  do {
    const data: {
      webhooks: {
        nodes: LinearWebhook[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } = await linearGraphql(
      `query Webhooks($after: String) {
        webhooks(after: $after) {
          nodes { url enabled }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { after },
    );
    webhooks.push(...data.webhooks.nodes);
    after = data.webhooks.pageInfo.hasNextPage ? data.webhooks.pageInfo.endCursor : null;
    if (data.webhooks.pageInfo.hasNextPage && after === null) {
      throw new Error("Linear GraphQL: webhooks page has no end cursor");
    }
  } while (after !== null);
  return webhooks;
}

export interface LinearIssueRef {
  id: string;
  identifier: string;
}

export interface LinearIssueState {
  id: string;
  name: string;
  type: string;
  position: number;
}

export interface LinearIssueStates {
  state: { id: string; name: string };
  team: { name: string; states: { nodes: LinearIssueState[] } };
}

/** Read an issue's current state and the states its team accepts. */
export async function fetchIssueStates(issueId: string): Promise<LinearIssueStates> {
  const data = await linearGraphql<{ issue: LinearIssueStates }>(
    `query IssueStates($id: String!) {
      issue(id: $id) {
        state { id name }
        team { name states { nodes { id name type position } } }
      }
    }`,
    { id: issueId },
  );
  return data.issue;
}

/** Change an issue to a state its team owns. */
export async function updateIssueState(issueId: string, stateId: string): Promise<void> {
  const data = await linearGraphql<{ issueUpdate: { success: boolean } }>(
    `mutation UpdateIssueState($issueId: String!, $stateId: String!) {
      issueUpdate(id: $issueId, input: { stateId: $stateId }) { success }
    }`,
    { issueId, stateId },
  );
  if (!data.issueUpdate.success) throw new Error(`Linear issueUpdate failed for issue ${issueId}`);
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

export async function getIssueParticipants(issueId: string): Promise<{
  creator: LinearUser | null;
  assignee: LinearUser | null;
}> {
  const data = await linearGraphql<{
    issue: { creator: LinearUser | null; assignee: LinearUser | null };
  }>(
    `query IssueParticipants($id: String!) {
      issue(id: $id) { creator { id name } assignee { id name } }
    }`,
    { id: issueId },
  );
  return { creator: data.issue.creator, assignee: data.issue.assignee };
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
export async function fetchIssueSnapshot(issueId: string): Promise<RawIssueSnapshot> {
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

/**
 * Post a comment on a ticket. An `id` (UUID v4) names the comment in advance, so a caller can
 * find it again after a lost response instead of posting twice.
 *
 * @group Create and update
 */
export async function createComment(
  issueId: string,
  body: string,
  id?: string,
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
    { input: { issueId, body, ...(id === undefined ? {} : { id }) } },
  );
  if (!data.commentCreate.success) {
    throw new Error(`Linear commentCreate failed for issue ${issueId}`);
  }
  return data.commentCreate.comment;
}

/**
 * A comment by id, or null when none exists. Filters rather than fetching by id, so a missing
 * comment is an empty answer and not an error.
 *
 * @group Resolve and read
 */
export async function findComment(id: string): Promise<{ id: string; createdAt: string } | null> {
  const data = await linearGraphql<{
    comments: { nodes: Array<{ id: string; createdAt: string }> };
  }>(
    `query FindComment($id: ID!) {
      comments(filter: { id: { eq: $id } }, first: 1) { nodes { id createdAt } }
    }`,
    { id },
  );
  return data.comments.nodes[0] ?? null;
}

/** One comment by id: where a human replies to it, and what it says. Linear
 *  mints the permalink, so nothing here guesses at an anchor. */
export async function getComment(id: string): Promise<{ url: string; body: string }> {
  const data = await linearGraphql<{
    comment: { url: string; body: string } | null;
  }>(`query Comment($id: String!) { comment(id: $id) { url body } }`, { id });
  if (data.comment === null) throw new Error(`Linear comment not found: ${id}`);
  return data.comment;
}

interface RawProject {
  id: string;
  teams: { nodes: Array<{ id: string }> };
}

const PROJECT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * Fields used to create a Linear ticket in a project's first team.
 *
 * @group Create and update
 */
export interface CreateIssueInProjectInput {
  project: string;
  title: string;
  description: string;
}

/**
 * Create a ticket in the project’s first team.
 *
 * @group Create and update
 */
export async function createIssueInProject(
  input: CreateIssueInProjectInput,
): Promise<{ id: string; identifier: string; url: string }> {
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

/**
 * A matching Linear ticket returned by a project title search.
 *
 * @group Resolve and read
 */
export interface LinearIssueMatch {
  id: string;
  identifier: string;
  url: string;
  title: string;
  description: string;
  state: string;
}

/**
 * Find the newest ticket in a project whose title starts with the given text.
 *
 * @group Resolve and read
 */
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
  return data.issue.comments.nodes.filter((comment) => comment.createdAt > sinceIso);
}

// Linear renders @-mentions in API-created comments as @[displayName](userId).
export function mention(user: LinearUser): string {
  return `@[${user.name}](${user.id})`;
}
