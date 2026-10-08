// The halt routine: ask in the run's Linear agent session, then suspend until
// someone answers there. Every provider call lives in the steps this routine is
// handed, so the body only sequences memoized step results.

import { createHook } from "workflow";
import type { HaltQuestion } from "../human/questions.ts";
import type { LinearAgentConversationSteps } from "./agent-conversation.ts";
import { type LinearAgentPrompt, linearListeningToken } from "./agent-session.ts";
import type { TicketClaim } from "./claim.ts";

/**
 * What the question says, in the words a stranger to the repo reads.
 * `headline` is one plain sentence naming what paused and why, `where`
 * names the routine it paused in so the footer can say so, `about` restates the
 * ticket itself, `notes` are plain bullet lines, and `onReply` decides what
 * the question asks the human to do: choose between the questions ("continue")
 * or repair something and let the step run again ("retry"). `mention` adds
 * people, by Linear email, to the operator (or the creator) and the assignee
 * the question already mentions; an email no Linear user has is skipped.
 *
 * @group Human input
 */
export type Halt = {
  headline: string;
  where: string;
  about?: string | undefined;
  questions?: HaltQuestion[] | undefined;
  notes?: string[] | undefined;
  onReply: "continue" | "retry";
  mention?: string[] | undefined;
};

/**
 * What people answered in the run's Linear agent session.
 *
 * @remarks
 * Every message sent since the run last read the session counts, including any sent before the
 * question. `body` holds every message oldest first, each after its author's name; `author` and
 * `createdAt` are the newest message's.
 *
 * @group Human input
 */
export interface HumanReply {
  body: string;
  author: { id: string; name: string };
  createdAt: string;
}

// Declared here rather than written as `typeof postTicketHumanInputRequest`:
// declaring the contract in workflow/ typechecks the step against the routine and
// keeps this side free of any value import into steps/.
/** Durable step contract for asking a question in the run's Linear agent session. */
export type PostTicketHumanInputRequest = (request: {
  installationName: string;
  issueId: string;
  sessionId: string;
  halt: Halt;
}) => Promise<void>;

/** Durable operations required to ask and resume a human halt. */
export type HaltForHumanDependencies = Pick<
  LinearAgentConversationSteps,
  "listLinearAgentSessionPrompts" | "postLinearAgentActivity"
> & { postTicketHumanInputRequest: PostTicketHumanInputRequest };

/** {@link haltForHuman} with its steps already bound, as a workflow calls it. */
export type HaltForHumanFn = (claim: TicketClaim, halt: Halt) => Promise<HumanReply>;

const CONTINUING = "Got it — continuing.";

/**
 * Ask in the claim's Linear agent session and suspend until someone replies there.
 *
 * @remarks
 * Messages the run has not read yet answer at once, even ones sent before the question. A stop is
 * no answer: the service cancels the run.
 */
export async function haltForHuman(
  claim: TicketClaim,
  halt: Halt,
  deps: HaltForHumanDependencies,
): Promise<HumanReply> {
  // Destructured, never invoked as `deps.postTicketHumanInputRequest(...)`: the SDK
  // serializes a step call's receiver along with its arguments, and this
  // object holds functions.
  const { listLinearAgentSessionPrompts, postLinearAgentActivity, postTicketHumanInputRequest } =
    deps;
  const { installationName, issueId, sessionId } = claim;
  const ref = { installationName, sessionId };
  // Created before the question so it registers with the question's step: a
  // reply sent while that step runs still wakes it. Holding it is also what
  // tells the service, and `jigs status`, that the run is waiting on a person.
  const listening = createHook<unknown>({
    token: linearListeningToken(installationName, sessionId),
  });
  const answer = async (): Promise<HumanReply | null> => {
    const unread = (await listLinearAgentSessionPrompts(ref)).filter(
      (prompt) => prompt.signal !== "stop" && !claim.consumedPromptIds.includes(prompt.id),
    );
    if (unread.length === 0) return null;
    claim.consumedPromptIds.push(...unread.map((prompt) => prompt.id));
    // A person's message puts the session back to pending; a thought makes it active again, so
    // the run's later notes, and its final one, land on a working session.
    await postLinearAgentActivity({ ...ref, content: { type: "thought", body: CONTINUING } });
    return joined(unread);
  };
  try {
    await postTicketHumanInputRequest({ installationName, issueId, sessionId, halt });
    const early = await answer();
    if (early !== null) return early;
    // A wake carries nothing: each one re-reads the session.
    for await (const _wake of listening) {
      const reply = await answer();
      if (reply !== null) return reply;
    }
    throw new Error("the listening hook stopped delivering wakes before a human replied");
  } finally {
    listening.dispose();
  }
}

function joined(prompts: LinearAgentPrompt[]): HumanReply {
  const last = prompts[prompts.length - 1] as LinearAgentPrompt;
  const body = prompts.map((prompt) => `${prompt.author.name}: ${prompt.body}`).join("\n\n");
  return { body, author: last.author, createdAt: last.createdAt };
}
