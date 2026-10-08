// The two messages a ticket run posts into its Linear agent session, as markdown.
//
// Plain TypeScript rather than a template: the layout is the contract here —
// real incrementing numbers, real option letters, one divider between
// questions — and a renderer that can be typechecked against `Halt` is what
// keeps a missing number from being a runtime surprise. A factory that wants a
// different-looking message passes its own function to the step instead of
// replacing the step.
//
// Linear does not renumber a markdown list, so every number and letter below
// is written out.

import type { LinearProfile } from "../../providers/linear.ts";
import type { HaltQuestion } from "../../workflow/human/questions.ts";
import type { Halt } from "../../workflow/linear/halt-for-human.ts";
import type { TicketNote } from "../../workflow/linear/review.ts";

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/**
 * Who the message is for. `mentions` is the final list the message greets, in
 * order and each person once: the operator (or, without one, the ticket's
 * creator), the assignee, then any extra people the step was asked to mention.
 * A custom renderer greets `mentions` rather than working it out again; the
 * other fields are there for context and may be null.
 *
 * @group Rendering/customization
 */
export type TicketParticipants = {
  creator: LinearProfile | null;
  assignee: LinearProfile | null;
  /** The configured operator, or null when none is set or Linear could not find them. */
  operator: LinearProfile | null;
  mentions: LinearProfile[];
};

/**
 * What the question's footer says about the run that asked it. The factory's
 * step wrapper builds it from the Workflow SDK's metadata, which the workflow
 * cannot see. Where the run paused belongs to the halt, not the context: only
 * the routine that raised it knows.
 *
 * @group Rendering/customization
 */
export type HumanInputContext = {
  runId: string;
  workflow?: string;
};

/**
 * Renders the question that asks a person to unblock a run.
 *
 * @group Rendering/customization
 */
export type RenderHumanInputRequest = (
  halt: Halt,
  context: HumanInputContext,
  participants: TicketParticipants,
) => string;

/**
 * Renders a note for ticket participants that asks for nothing.
 *
 * @group Rendering/customization
 */
export type RenderTicketNote = (note: TicketNote, participants: TicketParticipants) => string;

// Linear turns a profile link into a mention. Nobody to mention gets no
// greeting rather than a dangling dash.
function greet({ mentions }: TicketParticipants, headline: string): string {
  return mentions.length === 0
    ? headline
    : `${mentions.map((user) => user.url).join(" ")} — ${headline}`;
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
function footer(halt: Halt, context: HumanInputContext): string {
  const parts = [`Run ${context.runId}`];
  if (context.workflow !== undefined && context.workflow !== "") {
    parts.push(`workflow \`${context.workflow}\``);
  }
  parts.push(`paused at ${halt.where}`);
  return `<sub>${parts.join(" · ")}</sub>`;
}

/**
 * Render the default question as Linear Markdown.
 *
 * @group Rendering/customization
 */
export const renderHumanInputRequest: RenderHumanInputRequest = (halt, context, participants) => {
  const sections = [greet(participants, halt.headline)];
  if (halt.about !== undefined && halt.about !== "") {
    sections.push(`**What this ticket is about.** ${halt.about}`);
  }
  sections.push(
    halt.onReply === "retry"
      ? "Once this is fixed, reply here with anything and jigs will try the step again."
      : "Reply here with your choices, for example `1a, 2b`. Plain words or a question are fine too. Any reply wakes the run.",
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
 * Render the default ticket note as Linear Markdown.
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
