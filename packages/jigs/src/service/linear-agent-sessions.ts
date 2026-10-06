// The `linear.agentSessions` source: every Linear agent session created on an
// issue, by a mention of the factory's app or an assignment to it, is one
// occurrence, keyed by the session's id, read off the event the hub passes on.

import { z } from "zod";
import { HubResponseError } from "../providers/hub.ts";
import { type LinearIssueFiling, linearFor } from "../providers/linear.ts";
import {
  type LinearAgentSessionInputs,
  type LinearAgentSessionsParams,
  linearAgentSessionsParamsSchema,
} from "../workflow/linear/source.ts";
import type { Source } from "./event-triggers/sources.ts";

const headSchema = z.object({ type: z.string(), action: z.string() });

// Only what the occurrence and the filters read; Linear sends more.
const createdSchema = z.object({
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

const SAMPLE_INPUTS = {
  session: "00000000-0000-0000-0000-000000000000",
  installationName: "acme",
  issue: {
    id: "00000000-0000-0000-0000-000000000000",
    identifier: "ENG-1",
    title: "An issue",
    url: "https://linear.app/acme/issue/ENG-1/an-issue",
  },
  comment: "@jigs take a look",
  creator: { id: "00000000-0000-0000-0000-000000000000", name: "Ada", email: "ada@example.com" },
} satisfies LinearAgentSessionInputs;

// The issue's project and labels, read as the factory's app in the trigger's
// installation. An issue that is gone, or an installation the hub does not give
// this factory, will read the same way every time, so the session is passed
// over rather than retried.
async function readFiling(
  issueId: string,
  installationName: string,
): Promise<LinearIssueFiling | null> {
  try {
    const filing = await linearFor(installationName).fetchIssueFiling(issueId);
    if (filing === null)
      console.error(
        `[linear] ignored an agent session on issue ${issueId}, which the app cannot read`,
      );
    return filing;
  } catch (error) {
    if (!(error instanceof HubResponseError && error.status === 404)) throw error;
    console.error(
      `[linear] ignored an agent session in installation ${installationName}, which the hub does not give this factory: ${String(error)}`,
    );
    return null;
  }
}

export const LINEAR_AGENT_SESSIONS: Source<LinearAgentSessionsParams> = {
  provider: "linear",
  params: linearAgentSessionsParamsSchema,
  sampleInputs: SAMPLE_INPUTS,
  async fromPush(params, { installationName, payload: event }) {
    if (installationName !== params.installationName) return null;
    const head = headSchema.safeParse(event).data;
    if (head?.type !== "AgentSessionEvent" || head.action !== "created") return null;
    // A shape Linear will send the same way every time is no reason to retry.
    const created = createdSchema.safeParse(event);
    if (!created.success) {
      console.error(
        `[linear] ignored an agent session event it could not read: ${created.error.message}`,
      );
      return null;
    }
    const { agentSession } = created.data;
    const { issue } = agentSession;
    if (!issue) return null;
    if (
      params.teams &&
      !params.teams.some((team) => [issue.team.key, issue.team.id].includes(team))
    )
      return null;
    if (params.projects || params.labels) {
      const filing = await readFiling(issue.id, installationName);
      if (filing === null) return null;
      const { project, labels } = filing;
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
      installationName,
      issue: { id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url },
      comment: agentSession.comment?.body ?? null,
      creator: creator ? { id: creator.id, name: creator.name, email: creator.email } : null,
    } satisfies LinearAgentSessionInputs;
    return { key: agentSession.id, inputs, at: new Date(agentSession.createdAt) };
  },
  describe: ({ session, issue }) =>
    `linear ${String((issue as { identifier?: unknown } | undefined)?.identifier)} session ${String(session)}`,
};
