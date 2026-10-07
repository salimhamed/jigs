// A thin client for Linear's GraphQL API: only the calls jigs makes. These
// read env and hit the network, so a caller must reach them only from inside a
// "use step" function or from a route handler (the trigger's ticket lookup,
// the run-ref resolver) — never from a workflow body, where both are forbidden.

import { createHash } from "node:crypto";
import {
  currentFactoryContext,
  type FactoryContext,
  runSignal,
} from "../config/factory-context.ts";
import { JigsError } from "../errors.ts";
import {
  MAX_RATE_LIMIT_WAIT_SECONDS,
  ProviderApiError,
  type ProviderApiErrorInit,
  rateLimitWaits,
  retryAfterSeconds,
} from "./http.ts";
import {
  LINEAR_API_URL,
  type LinearAppUser,
  type LinearAuth,
  linearAuthFor,
} from "./linear-auth.ts";

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

/** A comment, with the Linear agent session it opened or replies in, if any. */
export interface LinearThreadComment extends LinearComment {
  agentSession: { id: string } | null;
  parent: { agentSession: { id: string } | null } | null;
}

interface GraphqlBody<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

function parseBody<T>(text: string): GraphqlBody<T> | undefined {
  try {
    return JSON.parse(text) as GraphqlBody<T>;
  } catch {
    return undefined;
  }
}

// Linear names a rejected credential in the errors array as well as with a 401.
function rejectedCredential(res: Response, text: string): boolean {
  return (
    res.status === 401 ||
    (parseBody(text)?.errors?.some((error) => error.extensions?.code === "AUTHENTICATION_ERROR") ??
      false)
  );
}

type Fail = (extra?: Pick<ProviderApiErrorInit, "code" | "detail">) => ProviderApiError;

function decodeGraphql<T>(res: Response, text: string, fail: Fail): T {
  if (!res.ok) throw fail();
  const body = parseBody<T>(text);
  if (body === undefined) throw fail({ detail: "response was not JSON" });
  const firstError = body.errors?.[0];
  if (firstError !== undefined) {
    throw fail({ code: firstError.extensions?.code, detail: firstError.message });
  }
  if (body.data === undefined) throw fail({ detail: "response carried no data" });
  return body.data;
}

const operationName = (query: string): string =>
  /\b(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "graphql";

export interface LinearClientDeps {
  /** The Linear installation, as named on the hub, the client acts through. */
  installationName: string;
  auth?: LinearAuth;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** The factory it acts for. Defaults to the process's own, resolved on each call. */
  context?: FactoryContext;
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

export interface LinearIssueFiling {
  project: { id: string; slugId: string } | null;
  labels: string[];
}

export interface LinearIssueStates {
  state: { id: string; name: string };
  team: { name: string; states: { nodes: LinearIssueState[] } };
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

interface RawProject {
  id: string;
  teams: { nodes: Array<{ id: string }> };
}

const PROJECT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export function createLinearClient(deps: LinearClientDeps) {
  const ctx = () => deps.context ?? currentFactoryContext();
  async function linearGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const auth = deps.auth ?? linearAuthFor(deps.installationName, ctx());
    let reauthorized = false;
    const rateLimit = rateLimitWaits("linear", runSignal, deps.sleep);
    for (;;) {
      const credential = await auth.bearer();
      const res = await (deps.fetch ?? fetch)(LINEAR_API_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });
      const text = await res.text();
      if (rejectedCredential(res, text) && !reauthorized) {
        auth.invalidate(credential);
        reauthorized = true;
        continue;
      }
      let detail: string | undefined;
      if (res.status === 429) {
        const seconds = retryAfterSeconds(res);
        if (await rateLimit.wait(seconds)) continue;
        if (seconds > MAX_RATE_LIMIT_WAIT_SECONDS) detail = `rate limited for ${seconds}s`;
      }
      const fail: Fail = (extra = {}) =>
        new ProviderApiError({
          provider: "linear",
          status: res.status,
          request: operationName(query),
          body: text,
          detail,
          ...extra,
        });
      // The hub refreshes a token before handing it out, so Linear refusing a
      // fresh one means the app has lost its access to the workspace.
      if (rejectedCredential(res, text))
        throw fail({
          detail: `Linear refused the app's token${reauthorized ? " again after the hub issued a fresh one" : ""}; connect the Linear workspace again in the hub`,
        });
      return decodeGraphql<T>(res, text, fail);
    }
  }

  /** The factory's own app user in the workspace, as the hub names it. */
  function appUser(): Promise<LinearAppUser> {
    return (deps.auth ?? linearAuthFor(deps.installationName, ctx())).user();
  }

  /** The active Linear user with this email, or null when none has it. */
  async function findUserByEmail(email: string): Promise<LinearUser | null> {
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

  /** Read an issue's current state and the states its team accepts. */
  async function fetchIssueStates(issueId: string): Promise<LinearIssueStates> {
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
  async function updateIssueState(issueId: string, stateId: string): Promise<void> {
    const data = await linearGraphql<{ issueUpdate: { success: boolean } }>(
      `mutation UpdateIssueState($issueId: String!, $stateId: String!) {
        issueUpdate(id: $issueId, input: { stateId: $stateId }) { success }
      }`,
      { issueId, stateId },
    );
    if (!data.issueUpdate.success)
      throw new JigsError(`Linear issueUpdate failed for issue ${issueId}`);
  }

  async function resolveIssueRef(ticket: string): Promise<LinearIssueRef> {
    const data = await linearGraphql<{ issue: LinearIssueRef | null }>(
      `query IssueRef($id: String!) {
        issue(id: $id) { id identifier }
      }`,
      { id: ticket },
    );
    if (data.issue === null) throw new JigsError(`Linear issue not found: ${ticket}`);
    return data.issue;
  }

  async function getIssueParticipants(issueId: string): Promise<{
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

  // The whole snapshot in one round trip, so every step in an activation reads
  // a copy taken at one instant. Unpaginated `last: 100` on comments is an
  // accepted cap: a ticket with more than 100 comments loses its oldest ones
  // from the reviewed copy.
  async function fetchIssueSnapshot(issueId: string): Promise<RawIssueSnapshot> {
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

  async function createComment(
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
      throw new JigsError(`Linear commentCreate failed for issue ${issueId}`);
    }
    return data.commentCreate.comment;
  }

  /**
   * A comment by id, or null when none exists. Filters rather than fetching by id, so a missing
   * comment is an empty answer and not an error.
   *
   * @group Resolve and read
   */
  async function findComment(id: string): Promise<{ id: string; createdAt: string } | null> {
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
  async function getComment(id: string): Promise<{ url: string; body: string }> {
    const data = await linearGraphql<{
      comment: { url: string; body: string } | null;
    }>(`query Comment($id: String!) { comment(id: $id) { url body } }`, { id });
    if (data.comment === null) throw new JigsError(`Linear comment not found: ${id}`);
    return data.comment;
  }

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
        throw new JigsError(`Linear project not found: ${ref}`);
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
      throw new JigsError(`Linear project not found: ${ref}`);
    }
    return project;
  }

  async function createIssueInProject(
    input: CreateIssueInProjectInput,
  ): Promise<{ id: string; identifier: string; url: string }> {
    const project = await resolveProject(input.project);
    const team = project.teams.nodes[0];
    if (team === undefined) {
      throw new JigsError(`Linear project has no team: ${input.project}`);
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
      throw new JigsError(`Linear issueCreate failed for project ${input.project}`);
    }
    return data.issueCreate.issue;
  }

  async function findIssueInProject(input: {
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

  async function listCommentsSince(
    issueId: string,
    sinceIso: string,
  ): Promise<LinearThreadComment[]> {
    const data = await linearGraphql<{
      issue: { comments: { nodes: LinearThreadComment[] } };
    }>(
      // Unpaginated `last: 50` is an accepted cap: wake re-checks only ever
      // need the comments since the previous check.
      `query IssueComments($id: String!) {
        issue(id: $id) {
          comments(last: 50) {
            nodes {
              id body createdAt user { id name }
              agentSession { id } parent { agentSession { id } }
            }
          }
        }
      }`,
      { id: issueId },
    );
    return data.issue.comments.nodes.filter((comment) => comment.createdAt > sinceIso);
  }

  /** The project and labels an issue is filed under. */
  /** Null when the issue is gone or the app cannot see it. */
  async function fetchIssueFiling(issueId: string): Promise<LinearIssueFiling | null> {
    const data = await linearGraphql<{
      issue: {
        project: { id: string; slugId: string } | null;
        labels: { nodes: Array<{ name: string }> };
      } | null;
    }>(
      `query IssueFiling($id: String!) {
        issue(id: $id) { project { id slugId } labels(first: 250) { nodes { name } } }
      }`,
      { id: issueId },
    );
    if (data.issue === null) return null;
    return {
      project: data.issue.project,
      labels: data.issue.labels.nodes.map((label) => label.name),
    };
  }

  return {
    graphql: linearGraphql,
    appUser,
    findUserByEmail,
    fetchIssueFiling,
    fetchIssueStates,
    updateIssueState,
    resolveIssueRef,
    getIssueParticipants,
    fetchIssueSnapshot,
    createComment,
    findComment,
    getComment,
    createIssueInProject,
    findIssueInProject,
    listCommentsSince,
  };
}

export type LinearClient = ReturnType<typeof createLinearClient>;

/** The factory's Linear client for one installation. */
export const linearFor = (installationName: string, context?: FactoryContext): LinearClient =>
  createLinearClient({ installationName, ...(context === undefined ? {} : { context }) });

/**
 * A UUID v4 derived from `parts`. Linear takes a caller's own id for a comment or an agent
 * activity, so one derived from what the post is for names it the same way on every retry.
 */
export function derivedUuid(parts: readonly string[]): string {
  const hex = createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "4";
  hex[16] = "89ab"[Number.parseInt(hex[16] ?? "0", 16) % 4] ?? "8";
  const id = hex.join("");
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

// Linear renders @-mentions in API-created comments as @[displayName](userId).
export function mention(user: LinearUser): string {
  return `@[${user.name}](${user.id})`;
}
