// The Linear agent session calls a factory wraps as its own steps, each through
// the Linear installation it names.

import { linearAgentFor } from "../../providers/linear-agent.ts";
import type {
  LinearAgentActivityContent,
  LinearAgentPrompt,
} from "../../workflow/linear/agent-session.ts";
import type { StepRunMetadata } from "../runtime/run-context.ts";
import { stepPostingId } from "./needs-human-comments.ts";

export type { LinearAgentActivityContent, LinearAgentPrompt };

/**
 * Post an activity into a Linear agent session as the factory's app.
 *
 * @remarks
 * Only a `thought` or an `action` may be `ephemeral`; Linear replaces an ephemeral activity with
 * the next one. Every retry of one step posts the same activity, so a lost response never posts
 * it twice.
 *
 * @group Linear agent sessions
 */
export async function postLinearAgentActivity(
  {
    installationName,
    sessionId,
    content,
    ephemeral,
  }: {
    installationName: string;
    sessionId: string;
    content: LinearAgentActivityContent;
    ephemeral?: boolean;
  },
  metadata: Pick<StepRunMetadata, "workflowRunId" | "stepId">,
): Promise<{ id: string; createdAt: string }> {
  return linearAgentFor(installationName).postActivityOnce(
    sessionId,
    content,
    stepPostingId(metadata, sessionId),
    ephemeral === undefined ? {} : { ephemeral },
  );
}

/**
 * Replace the links a Linear agent session shows, such as a pull request or the run's dashboard.
 *
 * @group Linear agent sessions
 */
export function setLinearAgentSessionUrls({
  installationName,
  sessionId,
  urls,
}: {
  installationName: string;
  sessionId: string;
  urls: Array<{ label: string; url: string }>;
}): Promise<void> {
  return linearAgentFor(installationName).setExternalUrls(sessionId, urls);
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
