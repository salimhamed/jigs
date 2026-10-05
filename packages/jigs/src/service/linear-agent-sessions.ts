// The `linear.agentSessions` source: every Linear agent session created on an
// issue, by a mention of the factory's app or an assignment to it, is one
// occurrence, keyed by the session's id. Linear sends these only as webhooks,
// which reach the factory through its hub, so the poll finds nothing.

import { z } from "zod";
import { createLinearClient, type LinearIssueFiling } from "../providers/linear.ts";
import { linearAuthFor } from "../providers/linear-auth.ts";
import {
  type LinearAgentSessionInputs,
  type LinearAgentSessionsParams,
  linearAgentSessionsParamsSchema,
} from "../workflow/linear/source.ts";
import type { Source } from "./event-triggers/sources.ts";

const headSchema = z.object({ type: z.string(), action: z.string() });

// Only what the occurrence and the filters read; Linear sends more.
const createdSchema = z.object({
  organizationId: z.string().min(1),
  agentSession: z.object({
    id: z.string().min(1),
    createdAt: z.iso.datetime({ offset: true }),
    issue: z
      .object({
        id: z.string().min(1),
        identifier: z.string(),
        title: z.string(),
        url: z.string(),
        team: z.object({ id: z.string(), key: z.string() }),
      })
      .nullish(),
    comment: z.object({ body: z.string() }).nullish(),
    creator: z.object({ id: z.string(), name: z.string(), email: z.string() }).nullish(),
  }),
});

export interface LinearAgentSessionsDeps {
  /** The issue's project and labels, read as the factory's app in the session's workspace. */
  issueFiling?: (issueId: string, workspace: string) => Promise<LinearIssueFiling>;
}

const SAMPLE_INPUTS = {
  session: "00000000-0000-0000-0000-000000000000",
  workspace: "00000000-0000-0000-0000-000000000000",
  issue: {
    id: "00000000-0000-0000-0000-000000000000",
    identifier: "ENG-1",
    title: "An issue",
    url: "https://linear.app/acme/issue/ENG-1/an-issue",
  },
  comment: "@jigs take a look",
  creator: { id: "00000000-0000-0000-0000-000000000000", name: "Ada", email: "ada@example.com" },
} satisfies LinearAgentSessionInputs;

export function linearAgentSessions(
  deps: LinearAgentSessionsDeps = {},
): Source<LinearAgentSessionsParams, null> {
  const issueFiling =
    deps.issueFiling ??
    ((issueId, workspace) =>
      createLinearClient({ auth: linearAuthFor(undefined, workspace) }).fetchIssueFiling(issueId));
  return {
    provider: "linear",
    params: linearAgentSessionsParamsSchema,
    cursor: z.null(),
    sampleInputs: SAMPLE_INPUTS,
    occurrence({ session }) {
      if (typeof session !== "string" || session === "")
        throw new Error("no agent session id in the occurrence");
      return session;
    },
    poll: async () => ({ occurrences: [], cursor: null }),
    async fromPush(params, event) {
      const head = headSchema.safeParse(event).data;
      if (head?.type !== "AgentSessionEvent" || head.action !== "created") return null;
      const { organizationId: workspace, agentSession } = createdSchema.parse(event);
      const { issue } = agentSession;
      if (!issue) return null;
      if (
        params.teams &&
        !params.teams.some((team) => [issue.team.key, issue.team.id].includes(team))
      )
        return null;
      if (params.projects || params.labels) {
        const { project, labels } = await issueFiling(issue.id, workspace);
        if (
          params.projects &&
          !params.projects.some(
            (ref) => project !== null && [project.id, project.slugId].includes(ref),
          )
        )
          return null;
        if (params.labels && !params.labels.some((label) => labels.includes(label))) return null;
      }
      const { creator } = agentSession;
      const inputs = {
        session: agentSession.id,
        workspace,
        issue: { id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url },
        comment: agentSession.comment?.body ?? null,
        creator: creator ? { id: creator.id, name: creator.name, email: creator.email } : null,
      } satisfies LinearAgentSessionInputs;
      return { inputs, at: new Date(agentSession.createdAt) };
    },
    describe: ({ session, issue }) =>
      `linear ${String((issue as { identifier?: unknown } | undefined)?.identifier)} session ${String(session)}`,
  };
}
