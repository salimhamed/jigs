// The Linear agent session calls a factory wraps as its own steps, each through
// the Linear installation it names.

import { linearAgentFor, onceActivityId } from "../../providers/linear-agent.ts";
import type {
  LinearAgentActivityContent,
  LinearAgentPrompt,
} from "../../workflow/linear/agent-session.ts";
import { dashboardRunUrl, type RunMetadata, type StepRunMetadata } from "../runtime/run-context.ts";
import { stepPostingId } from "./needs-human-comments.ts";

export type { LinearAgentActivityContent, LinearAgentPrompt };

/**
 * Post an activity into a Linear agent session as the factory's app.
 *
 * @remarks
 * Only a `thought` or an `action` may be `ephemeral`; Linear replaces an ephemeral activity with
 * the next one. Every retry of one step posts the same activity, so a lost response never posts
 * it twice. With `once`, the activity is posted at most once per key in the session, from any
 * step.
 *
 * @group Linear agent sessions
 */
export async function postLinearAgentActivity(
  {
    installationName,
    sessionId,
    content,
    ephemeral,
    once,
  }: {
    installationName: string;
    sessionId: string;
    content: LinearAgentActivityContent;
    ephemeral?: boolean;
    once?: string;
  },
  metadata: Pick<StepRunMetadata, "workflowRunId" | "stepId">,
): Promise<{ id: string; createdAt: string }> {
  return linearAgentFor(installationName).postActivityOnce(
    sessionId,
    content,
    once === undefined ? stepPostingId(metadata, sessionId) : onceActivityId(sessionId, once),
    ephemeral === undefined ? {} : { ephemeral },
  );
}

/**
 * Replace the links a Linear agent session shows, such as a pull request. The run's dashboard
 * comes first when the service hosts one.
 *
 * @group Linear agent sessions
 */
export async function setLinearAgentSessionUrls(
  {
    installationName,
    sessionId,
    urls,
  }: {
    installationName: string;
    sessionId: string;
    urls: Array<{ label: string; url: string }>;
  },
  metadata: RunMetadata,
): Promise<void> {
  const dashboard = dashboardRunUrl(metadata.workflowRunId);
  const all = dashboard === undefined ? urls : [{ label: "jigs run", url: dashboard }, ...urls];
  await linearAgentFor(installationName).setExternalUrls(sessionId, all);
}

/**
 * Read every message people sent into a Linear agent session, oldest first.
 *
 * @remarks
 * The mention that opened the session is not one of them. A message whose `signal` is `"stop"` is
 * the person pressing stop.
 *
 * @group Linear agent sessions
 */
export function listLinearAgentSessionPrompts({
  installationName,
  sessionId,
}: {
  installationName: string;
  sessionId: string;
}): Promise<LinearAgentPrompt[]> {
  return linearAgentFor(installationName).listPrompts(sessionId);
}
