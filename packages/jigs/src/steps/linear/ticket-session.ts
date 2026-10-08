// The Linear calls haltForHuman and noteOnTicket are handed: each posts one
// activity, a question or a note, into the run's Linear agent session and
// mentions the ticket's people in it. Both reach the network, so the factory
// wraps them as steps.
//
// The markdown itself lives in ./render.ts. Each step takes its renderer as an
// optional argument, so a factory that wants a different-looking message passes
// its own function from its step wrapper and replaces no step.

import { linearFor } from "../../providers/linear.ts";
import { linearAgentFor } from "../../providers/linear-agent.ts";
import type { FactoryDefinition } from "../../workflow/factory.ts";
import type { PostTicketHumanInputRequest } from "../../workflow/linear/halt-for-human.ts";
import type { PostTicketNote } from "../../workflow/linear/review.ts";
import type { StepRunMetadata } from "../runtime/run-context.ts";
import { stepPostingId } from "./agent-sessions.ts";
import { resolveParticipants } from "./mentions.ts";
import {
  type RenderHumanInputRequest,
  type RenderTicketNote,
  renderHumanInputRequest,
  renderTicketNote,
} from "./render.ts";

/**
 * Ask in the run's Linear agent session for a person to help the run continue.
 *
 * @remarks
 * Posts the halt as an elicitation, which shows the session as waiting for input. Mentions the
 * factory's `linear.operator`, or the ticket's creator when it is not set, then the assignee and
 * the halt's `mention` emails, each person once. A person Linear cannot find is skipped with a
 * warning; the question always posts. `definition` is the built factory definition the step
 * wrapper passes in, so a changed operator takes effect after a rebuild, which `jigs up` does.
 *
 * @group Human interaction primitives
 */
export const postTicketHumanInputRequest = async (
  { installationName, issueId, sessionId, halt }: Parameters<PostTicketHumanInputRequest>[0],
  metadata: StepRunMetadata,
  definition: FactoryDefinition,
  render: RenderHumanInputRequest = renderHumanInputRequest,
): ReturnType<PostTicketHumanInputRequest> => {
  const participants = await resolveParticipants(linearFor(installationName), issueId, {
    operator: definition.linear?.operator,
    mention: halt.mention,
  });
  const body = render(
    halt,
    { runId: metadata.workflowRunId, workflow: metadata.workflowName },
    participants,
  );
  await linearAgentFor(installationName).postActivityOnce(
    sessionId,
    { type: "elicitation", body },
    stepPostingId(metadata, sessionId),
  );
  console.log(`[postTicketHumanInputRequest] asked session=${sessionId} issue=${issueId}`);
};

/**
 * Tell ticket participants something in the run's Linear agent session, without waiting for a
 * reply.
 *
 * @remarks
 * A note that ends the run is the session's final response, even for a failure: Linear offers
 * Retry on a session that ends in an error, and a run that has ended cannot take it. A note
 * that waits on people is an elicitation, which shows the session as awaiting input. Any other
 * note is a response followed by a short thought, which keeps the session working so Stop still
 * ends the run. Mentions in each of them notify. Mentions the same people as
 * {@link postTicketHumanInputRequest}, with the note's `mention` emails as the extras.
 *
 * @group Human interaction primitives
 */
export const postTicketNote = async (
  { installationName, issueId, sessionId, note }: Parameters<PostTicketNote>[0],
  metadata: StepRunMetadata,
  definition: FactoryDefinition,
  render: RenderTicketNote = renderTicketNote,
): ReturnType<PostTicketNote> => {
  const participants = await resolveParticipants(linearFor(installationName), issueId, {
    operator: definition.linear?.operator,
    mention: note.mention,
  });
  const linear = linearAgentFor(installationName);
  const type = note.run === "waiting" ? "elicitation" : "response";
  await linear.postActivityOnce(
    sessionId,
    { type, body: render(note, participants) },
    stepPostingId(metadata, sessionId),
  );
  if (note.run === undefined) {
    await linear.postActivityOnce(
      sessionId,
      { type: "thought", body: STILL_WORKING },
      stepPostingId(metadata, `${sessionId}:working`),
    );
  }
  console.log(`[postTicketNote] posted ${type} session=${sessionId} issue=${issueId}`);
};

const STILL_WORKING = "Still working.";
