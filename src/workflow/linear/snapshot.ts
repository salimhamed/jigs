// The per-activation copy of a Linear ticket. Contents are fixed: title,
// description, labels, comments, blocker/blocking relations, attached links,
// sub-issue ids/titles — no file attachments, and deep or live reads are
// opt-in through a per-step Linear MCP server rather than widened here.
// `branchName` is Linear's gitBranchName, the worktree branch default. Every
// step in one activation reads the same snapshot value.

import type { RawIssueSnapshot } from "../../providers/linear.ts";

/**
 * A compact reference to a related Linear ticket.
 *
 * @group Linear tickets
 */
export type TicketRef = {
  id: string;
  identifier: string;
  title: string;
};

/**
 * A Linear ticket comment captured in a workflow snapshot.
 *
 * @group Linear tickets
 */
export type TicketComment = {
  id: string;
  body: string;
  createdAt: string;
  author: string | null;
};

/**
 * A named external link attached to a Linear ticket.
 *
 * @group Linear tickets
 */
export type TicketLink = {
  title: string;
  url: string;
};

/**
 * The fixed ticket state shared by every step in one workflow activation.
 *
 * @group Linear tickets
 */
export type TicketSnapshot = {
  fetchedAt: string;
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  branchName: string;
  state: string;
  labels: string[];
  comments: TicketComment[];
  blockedBy: TicketRef[];
  blocks: TicketRef[];
  links: TicketLink[];
  subIssues: TicketRef[];
};

/** Normalize a provider response into the stable ticket shape a workflow reads. */
export function toTicketSnapshot(raw: RawIssueSnapshot, fetchedAt: string): TicketSnapshot {
  return {
    fetchedAt,
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    description: raw.description ?? "",
    url: raw.url,
    branchName: raw.branchName,
    state: raw.state.name,
    labels: raw.labels.nodes.map((label) => label.name),
    comments: raw.comments.nodes.map((comment) => ({
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt,
      author: comment.user?.name ?? null,
    })),
    // relations point outward (this issue blocks that one); inverseRelations
    // point inward (that one blocks this issue).
    blocks: raw.relations.nodes
      .filter((relation) => relation.type === "blocks")
      .map((relation) => relation.relatedIssue),
    blockedBy: raw.inverseRelations.nodes
      .filter((relation) => relation.type === "blocks")
      .map((relation) => relation.issue),
    links: raw.attachments.nodes.map((attachment) => ({
      title: attachment.title,
      url: attachment.url,
    })),
    subIssues: raw.children.nodes,
  };
}

function refLines(refs: TicketRef[]): string[] {
  return refs.map((ref) => `- ${ref.identifier} ${ref.title}`);
}

function section(heading: string, lines: string[]): string[] {
  return lines.length === 0 ? [] : ["", `## ${heading}`, "", ...lines];
}

/**
 * Render a ticket snapshot as Markdown for an agent prompt.
 *
 * @group Linear tickets
 */
export function renderTicketSnapshot(snapshot: TicketSnapshot): string {
  const lines = [
    `# ${snapshot.identifier} ${snapshot.title}`,
    "",
    `- URL: ${snapshot.url}`,
    `- State: ${snapshot.state}`,
    `- Labels: ${snapshot.labels.length === 0 ? "none" : snapshot.labels.join(", ")}`,
    "",
    "## Description",
    "",
    snapshot.description === "" ? "_(empty)_" : snapshot.description,
    "",
    "## Comments",
    "",
    ...(snapshot.comments.length === 0
      ? ["_(none)_"]
      : snapshot.comments.map((comment) =>
          [`### ${comment.author ?? "unknown"} — ${comment.createdAt}`, "", comment.body].join(
            "\n",
          ),
        )),
    ...section("Blocked by", refLines(snapshot.blockedBy)),
    ...section("Blocks", refLines(snapshot.blocks)),
    ...section(
      "Links",
      snapshot.links.map((link) => `- [${link.title}](${link.url})`),
    ),
    ...section("Sub-issues", refLines(snapshot.subIssues)),
  ];
  return `${lines.join("\n")}\n`;
}
