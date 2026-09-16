// The two Linear comments jigs writes, as markdown.
//
// Plain TypeScript rather than a template: the layout is the contract here —
// real incrementing numbers, real option letters, one divider between
// questions — and a renderer that can be typechecked against `Halt` is what
// keeps a missing number from being a runtime surprise. A factory that wants a
// different-looking comment passes its own function to the step instead of
// replacing the step.
//
// Linear does not renumber a markdown list, so every number and letter below
// is written out.

import type { Halt, HaltQuestion } from "../../blocks/ticket/halt-for-human.ts";
import type { TicketNote } from "../../blocks/ticket/review.ts";
import { type LinearUser, mention } from "../../providers/linear.ts";

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** Who the comment greets. Either may be absent, and they are often the same. */
export type TicketParticipants = {
  creator: LinearUser | null;
  assignee: LinearUser | null;
};

/**
 * What the comment's footer says about the run that posted it. The factory's
 * step wrapper builds it: the run id and the workflow name come from the
 * Workflow SDK's metadata, and the dashboard link from the service's own
 * configuration — none of it visible to a block. Where the run paused is the
 * halt's, not the context's: only the block that raised it knows.
 */
export type NeedsHumanContext = {
  runId: string;
  workflow?: string;
  dashboardUrl?: string;
};

export type RenderNeedsHumanComment = (
  halt: Halt,
  context: NeedsHumanContext,
  participants: TicketParticipants,
) => string;

export type RenderTicketNote = (note: TicketNote, participants: TicketParticipants) => string;

// Creator and assignee, in that order, each named once. Either may be absent;
// a ticket nobody created and nobody owns gets no greeting rather than a
// dangling dash.
function greet(participants: TicketParticipants, headline: string): string {
  const seen = new Set<string>();
  const people: LinearUser[] = [];
  for (const user of [participants.creator, participants.assignee]) {
    if (user === null || seen.has(user.id)) continue;
    seen.add(user.id);
    people.push(user);
  }
  return people.length === 0 ? headline : `${people.map(mention).join(" ")} — ${headline}`;
}

function questionBlock(question: HaltQuestion, index: number): string {
  const parts = [`### ${index + 1}. ${question.question}`];
  if (question.context !== undefined && question.context !== "") {
    parts.push(question.context);
  }
  const options = question.options ?? [];
  if (options.length > 0) {
    parts.push(
      options
        .map(
          (option, letter) =>
            `- **${LETTERS[letter]})** ${option.label}${option.recommended === true ? " *(recommended)*" : ""}`,
        )
        .join("\n"),
    );
  }
  return parts.join("\n\n");
}

// Where the run paused, not when: a human reading this wants to know which
// part of the work is waiting on them, and a timestamp answers a question
// nobody asked.
function footer(halt: Halt, context: NeedsHumanContext): string {
  const parts = [`Run ${context.runId}`];
  if (context.workflow !== undefined && context.workflow !== "") {
    parts.push(`workflow \`${context.workflow}\``);
  }
  parts.push(`paused at ${halt.where}`);
  if (context.dashboardUrl !== undefined && context.dashboardUrl !== "") {
    parts.push(`[dashboard](${context.dashboardUrl})`);
  }
  return `<sub>${parts.join(" · ")}</sub>`;
}

export const renderNeedsHumanComment: RenderNeedsHumanComment = (halt, context, participants) => {
  const blocks = [greet(participants, halt.headline)];
  if (halt.about !== undefined && halt.about !== "") {
    blocks.push(`**What this ticket is about.** ${halt.about}`);
  }
  blocks.push(
    halt.onReply === "retry"
      ? "Once this is fixed, reply with anything and jigs will try the step again."
      : "Reply to this comment with your choices, for example `1a, 2b`. Plain words or a question are fine too. Any reply wakes the run.",
  );
  for (const [index, question] of (halt.questions ?? []).entries()) {
    blocks.push("---", questionBlock(question, index));
  }
  const notes = halt.notes ?? [];
  if (notes.length > 0) {
    blocks.push("---", notes.map((note) => `- ${note}`).join("\n"));
  }
  blocks.push("---", footer(halt, context));
  return `${blocks.join("\n\n")}\n`;
};

export const renderTicketNote: RenderTicketNote = (note, participants) =>
  `${[
    greet(participants, note.headline),
    note.notes.map((line) => `- ${line}`).join("\n"),
    note.closing,
  ]
    .filter(Boolean)
    .join("\n\n")}\n`;
