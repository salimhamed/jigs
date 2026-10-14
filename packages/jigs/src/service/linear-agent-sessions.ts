// The `linear.delegations` and `linear.mentions` sources: every Linear agent
// session a person created on an issue, by delegating it to the factory's app or
// mentioning the app, is one occurrence of one of them, keyed by the session's id,
// read off the event the hub passes on.

import { z } from "zod";
import { type LinearIssueFiling, linearFor } from "../providers/linear.ts";
import {
  type LinearAgentSessionsParams,
  type LinearDelegationInputs,
  type LinearMentionInputs,
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
    comment: z.object({ body: z.string(), userId: z.string().nullish() }).nullish(),
    creator: z.object({ id: z.string(), name: z.string(), email: z.string() }).nullish(),
  }),
  promptContext: z.string().nullish().catch(null),
});

const SAMPLE_DELEGATION = {
  session: "00000000-0000-0000-0000-000000000000",
  installationName: "acme",
  issue: {
    id: "00000000-0000-0000-0000-000000000000",
    identifier: "ENG-1",
    title: "An issue",
    url: "https://linear.app/acme/issue/ENG-1/an-issue",
  },
  promptContext: '<issue identifier="ENG-1">\n<title>An issue</title>\n</issue>',
  creator: { id: "00000000-0000-0000-0000-000000000000", name: "Ada", email: "ada@example.com" },
} satisfies LinearDelegationInputs;

// The issue's project and labels, read as the factory's app in the trigger's
// installation. An issue that is gone will read the same way every time, so the
// session is passed over rather than retried.
async function readFiling(
  issueId: string,
  installationName: string,
): Promise<LinearIssueFiling | null> {
  const filing = await linearFor(installationName).fetchIssueFiling(issueId);
  if (filing === null)
    console.error(
      `[linear] ignored an agent session on issue ${issueId}, which the app cannot read`,
    );
  return filing;
}

// Linear gives every session a comment. A delegation's is a placeholder Linear writes
// itself, so a mention is a session whose comment its creator wrote.
const agentSessions = (
  started: "delegation" | "mention",
  sampleInputs: Record<string, unknown>,
): Source<LinearAgentSessionsParams> => ({
  provider: "linear",
  params: linearAgentSessionsParamsSchema,
  sampleInputs,
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
    const { agentSession, promptContext } = created.data;
    const { issue, creator } = agentSession;
    // A session with no creator is one the app opened itself, for a run already working on it.
    if (!issue || !creator) return null;
    const comment = agentSession.comment;
    const mention = comment != null && comment.userId === creator.id;
    if (mention !== (started === "mention")) return null;
    if (
      params.teams &&
      !params.teams.some((team) => [issue.team.key, issue.team.id].includes(team))
    )
      return null;
    if (
      params.creators &&
      !params.creators.some((email) => email.toLowerCase() === creator.email.toLowerCase())
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
    const delegation = {
      session: agentSession.id,
      installationName,
      issue: { id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url },
      promptContext: promptContext ?? null,
      creator: { id: creator.id, name: creator.name, email: creator.email },
    } satisfies LinearDelegationInputs;
    const inputs = mention
      ? ({ ...delegation, comment: comment.body } satisfies LinearMentionInputs)
      : delegation;
    return { key: agentSession.id, inputs, at: new Date(agentSession.createdAt) };
  },
  describe: ({ session, issue }) =>
    `linear ${String((issue as { identifier?: unknown } | undefined)?.identifier)} session ${String(session)}`,
});

export const LINEAR_DELEGATIONS = agentSessions("delegation", SAMPLE_DELEGATION);
export const LINEAR_MENTIONS = agentSessions("mention", {
  ...SAMPLE_DELEGATION,
  comment: "@jigs take a look",
} satisfies LinearMentionInputs);
