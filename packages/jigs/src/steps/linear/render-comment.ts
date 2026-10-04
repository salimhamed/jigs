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

import { type LinearUser, mention } from "../../providers/linear.ts";
import type { HaltQuestion } from "../../workflow/human/questions.ts";
import type { Halt } from "../../workflow/linear/halt-for-human.ts";
import type { TicketNote } from "../../workflow/linear/review.ts";

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/**
 * Who the comment is for. `mentions` is the final list the comment greets, in
 * order and each person once: the operator (or, without one, the ticket's
 * creator), the assignee, then any extra people the step was asked to mention.
 * A custom renderer greets `mentions` rather than working it out again; the
 * other fields are there for context and may be null.
 *
 * @group Rendering/customization
 */
export type TicketParticipants = {
  creator: LinearUser | null;
  assignee: LinearUser | null;
  /** The configured operator, or null when none is set or Linear could not find them. */
  operator: LinearUser | null;
  mentions: LinearUser[];
};

/**
 * What the comment's footer says about the run that posted it. The factory's
 * step wrapper builds it: the run id and the workflow name come from the
 * Workflow SDK's metadata, and the dashboard link from the service's own
 * configuration. None of it is visible to the workflow. Where the run paused
 * belongs to the halt, not the context: only the routine that raised it knows.
 *
 * @group Rendering/customization
 */
export type NeedsHumanContext = {
  runId: string;
  workflow?: string;
  dashboardUrl?: string;
};

/**
 * Renders the Linear comment that asks a person to unblock a run.
 *
 * @group Rendering/customization
 */
export type RenderNeedsHumanComment = (
  halt: Halt,
  context: NeedsHumanContext,
  participants: TicketParticipants,
) => string;

/**
 * Renders a non-blocking Linear note for ticket participants.
 *
 * @group Rendering/customization
 */
export type RenderTicketNote = (note: TicketNote, participants: TicketParticipants) => string;

// Nobody to mention gets no greeting rather than a dangling dash.
function greet({ mentions }: TicketParticipants, headline: string): string {
  return mentions.length === 0 ? headline : `${mentions.map(mention).join(" ")} — ${headline}`;
}

function questionSection(question: HaltQuestion, index: number): string {
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

/**
 * Render the default human-input request as Linear Markdown.
 *
 * @group Rendering/customization
 */
export const renderNeedsHumanComment: RenderNeedsHumanComment = (halt, context, participants) => {
  const sections = [greet(participants, halt.headline)];
  if (halt.about !== undefined && halt.about !== "") {
    sections.push(`**What this ticket is about.** ${halt.about}`);
  }
  sections.push(
    halt.onReply === "retry"
      ? "Once this is fixed, reply with anything and jigs will try the step again."
      : "Reply to this comment with your choices, for example `1a, 2b`. Plain words or a question are fine too. Any reply wakes the run.",
  );
  for (const [index, question] of (halt.questions ?? []).entries()) {
    sections.push("---", questionSection(question, index));
  }
  const notes = halt.notes ?? [];
  if (notes.length > 0) {
    sections.push("---", notes.map((note) => `- ${note}`).join("\n"));
  }
  sections.push("---", footer(halt, context));
  return `${sections.join("\n\n")}\n`;
};

/**
 * Render the default non-blocking ticket note as Linear Markdown.
 *
 * @group Rendering/customization
 */
export const renderTicketNote: RenderTicketNote = (note, participants) =>
  `${[
    greet(participants, note.headline),
    note.notes.map((line) => `- ${line}`).join("\n"),
    note.closing,
  ]
    .filter(Boolean)
    .join("\n\n")}\n`;
