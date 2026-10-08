// Linear's agent API, which Linear calls a Developer Preview: every GraphQL
// query and mutation jigs sends about a Linear agent session lives here, so a
// change on Linear's side is a change to this one file.

import type { FactoryContext } from "../config/factory-context.ts";
import { JigsError } from "../errors.ts";
import type {
  LinearAgentActivityContent,
  LinearAgentPrompt,
} from "../workflow/linear/agent-session.ts";
import { derivedUuid, type LinearClient, linearFor } from "./linear.ts";

export type { LinearAgentActivityContent, LinearAgentPrompt };

interface RawPrompt {
  id: string;
  createdAt: string;
  signal: string | null;
  content: { __typename: string; body?: string };
  user: { id: string; name: string };
  sourceComment: { id: string } | null;
}

interface Page<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

const PAGE_SIZE = 100;

export function createLinearAgentApi(linear: Pick<LinearClient, "graphql">) {
  const { graphql } = linear;

  /**
   * Post an activity into a session as the factory's app. Only a `thought` or an `action` may be
   * ephemeral: Linear replaces it with the next activity. An `id` (UUID v4) names the activity in
   * advance, so a caller can find it again after a lost response.
   */
  async function postActivity(
    sessionId: string,
    content: LinearAgentActivityContent,
    options: { ephemeral?: boolean; id?: string } = {},
  ): Promise<{ id: string; createdAt: string }> {
    if (options.ephemeral && content.type !== "thought" && content.type !== "action") {
      throw new JigsError(`a Linear agent ${content.type} cannot be ephemeral`);
    }
    const data = await graphql<{
      agentActivityCreate: { success: boolean; agentActivity: { id: string; createdAt: string } };
    }>(
      `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
        agentActivityCreate(input: $input) { success agentActivity { id createdAt } }
      }`,
      {
        input: {
          agentSessionId: sessionId,
          content,
          ...(options.ephemeral ? { ephemeral: true } : {}),
          ...(options.id === undefined ? {} : { id: options.id }),
        },
      },
    );
    if (!data.agentActivityCreate.success) {
      throw new JigsError(`Linear agentActivityCreate failed for session ${sessionId}`);
    }
    return data.agentActivityCreate.agentActivity;
  }

  /**
   * Post an activity under `id` unless it is already there. A retry after a lost response creates
   * the same id again, which Linear refuses; only then is it worth a read to find the first one.
   */
  async function postActivityOnce(
    sessionId: string,
    content: LinearAgentActivityContent,
    id: string,
    options: { ephemeral?: boolean } = {},
  ): Promise<{ id: string; createdAt: string }> {
    try {
      return await postActivity(sessionId, content, { ...options, id });
    } catch (error) {
      const created = await findActivity(id).catch(() => null);
      if (created !== null) return created;
      throw error;
    }
  }

  /** An activity by id, or null when none exists. */
  async function findActivity(id: string): Promise<{ id: string; createdAt: string } | null> {
    const data = await graphql<{
      agentActivities: { nodes: Array<{ id: string; createdAt: string }> };
    }>(
      `query FindAgentActivity($id: ID!) {
        agentActivities(filter: { id: { eq: $id } }, first: 1) { nodes { id createdAt } }
      }`,
      { id },
    );
    return data.agentActivities.nodes[0] ?? null;
  }

  /**
   * Open a session on an issue as the factory's app, and return its id. Linear keeps a session
   * the app opened `pending` until it has links, so pass them here.
   */
  async function createSession(
    issueId: string,
    urls: ReadonlyArray<{ label: string; url: string }>,
  ): Promise<string> {
    const data = await graphql<{
      agentSessionCreateOnIssue: { success: boolean; agentSession: { id: string } };
    }>(
      `mutation AgentSessionCreateOnIssue($input: AgentSessionCreateOnIssue!) {
        agentSessionCreateOnIssue(input: $input) { success agentSession { id } }
      }`,
      { input: { issueId, externalUrls: urls.map(({ label, url }) => ({ label, url })) } },
    );
    if (!data.agentSessionCreateOnIssue.success) {
      throw new JigsError(`Linear agentSessionCreateOnIssue failed for issue ${issueId}`);
    }
    return data.agentSessionCreateOnIssue.agentSession.id;
  }

  /** Replace the links Linear shows on the session. */
  async function setExternalUrls(
    sessionId: string,
    urls: ReadonlyArray<{ label: string; url: string }>,
  ): Promise<void> {
    const data = await graphql<{ agentSessionUpdate: { success: boolean } }>(
      `mutation AgentSessionUrls($id: String!, $input: AgentSessionUpdateInput!) {
        agentSessionUpdate(id: $id, input: $input) { success }
      }`,
      { id: sessionId, input: { externalUrls: urls.map(({ label, url }) => ({ label, url })) } },
    );
    if (!data.agentSessionUpdate.success) {
      throw new JigsError(`Linear agentSessionUpdate failed for session ${sessionId}`);
    }
  }

  /**
   * Every prompt in the session, oldest first: the replies and signals people sent. The mention
   * that opened the session is its comment, not a prompt.
   */
  async function listPrompts(sessionId: string): Promise<LinearAgentPrompt[]> {
    const prompts: LinearAgentPrompt[] = [];
    let after: string | null = null;
    for (;;) {
      const data: { agentSession: { activities: Page<RawPrompt> } } = await graphql(
        `query AgentSessionPrompts($id: String!, $first: Int!, $after: String) {
          agentSession(id: $id) {
            activities(filter: { type: { eq: "prompt" } }, first: $first, after: $after) {
              nodes {
                id createdAt signal
                content { __typename ... on AgentActivityPromptContent { body } }
                user { id name }
                sourceComment { id }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,
        { id: sessionId, first: PAGE_SIZE, after },
      );
      const { nodes, pageInfo } = data.agentSession.activities;
      for (const node of nodes) {
        if (node.content.__typename !== "AgentActivityPromptContent") continue;
        prompts.push({
          id: node.id,
          createdAt: node.createdAt,
          body: node.content.body ?? "",
          signal: node.signal,
          author: { id: node.user.id, name: node.user.name },
          sourceCommentId: node.sourceComment?.id ?? null,
        });
      }
      if (!pageInfo.hasNextPage || pageInfo.endCursor === null) break;
      after = pageInfo.endCursor;
    }
    // Linear returns a session's activities newest first.
    return prompts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Whether the app posted a `response` or an `error`, the activities that end its turn, after `since`. */
  async function answeredSince(sessionId: string, since: string): Promise<boolean> {
    const data = await graphql<{ agentSession: { activities: { nodes: Array<{ id: string }> } } }>(
      `query AgentSessionAnswered($id: String!, $since: DateTimeOrDuration!) {
        agentSession(id: $id) {
          activities(
            filter: { type: { in: ["response", "error"] }, createdAt: { gt: $since } }
            first: 1
          ) { nodes { id } }
        }
      }`,
      { id: sessionId, since },
    );
    return data.agentSession.activities.nodes.length > 0;
  }

  /** Whether the app's last activity before `at` was a question, still open when a reply came. */
  async function askedBefore(sessionId: string, at: string): Promise<boolean> {
    const data = await graphql<{
      agentSession: { activities: { nodes: Array<{ content: { __typename: string } }> } };
    }>(
      `query AgentSessionAskedBefore($id: String!, $at: DateTimeOrDuration!) {
        agentSession(id: $id) {
          activities(
            filter: {
              type: { in: ["thought", "action", "elicitation", "response", "error"] }
              createdAt: { lt: $at }
            }
            first: 1
          ) { nodes { content { __typename } } }
        }
      }`,
      { id: sessionId, at },
    );
    // Linear returns a session's activities newest first.
    const last = data.agentSession.activities.nodes[0];
    return last?.content.__typename === "AgentActivityElicitationContent";
  }

  return {
    postActivity,
    postActivityOnce,
    findActivity,
    createSession,
    setExternalUrls,
    listPrompts,
    answeredSince,
    askedBefore,
  };
}

/** The id of the activity posted once under `key` in a session, whoever posts it. */
export const onceActivityId = (sessionId: string, key: string): string =>
  derivedUuid(["linear-agent-activity", sessionId, key]);

export type LinearAgentApi = ReturnType<typeof createLinearAgentApi>;

/** The factory's Linear agent API for one installation. */
export const linearAgentFor = (
  installationName: string,
  context?: FactoryContext,
): LinearAgentApi => createLinearAgentApi(linearFor(installationName, context));
