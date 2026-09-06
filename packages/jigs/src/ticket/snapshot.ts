// The per-activation copy of a Linear ticket (ADR 0002). Contents are fixed:
// title, description, labels, comments, blocker/blocking relations, attached
// links, sub-issue ids/titles — no file attachments, and deep or live reads
// are opt-in through a per-step Linear MCP server rather than widened here.
// `branchName` is Linear's gitBranchName, the worktree branch default. Every
// step in one activation reads the same snapshot value.

import {
  fetchIssueSnapshot,
  type RawIssueSnapshot,
} from "../providers/linear.ts";

// Type aliases, not interfaces: aliases carry an implicit index signature,
// which keeps step returns assignable to the SDK's Serializable types.

export type TicketRef = {
  id: string;
  identifier: string;
  title: string;
};

export type SnapshotComment = {
  id: string;
  body: string;
  createdAt: string;
  author: string | null;
};

export type TicketLink = {
  title: string;
  url: string;
};

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
  comments: SnapshotComment[];
  blockedBy: TicketRef[];
  blocks: TicketRef[];
  links: TicketLink[];
  subIssues: TicketRef[];
};

export function toSnapshot(
  raw: RawIssueSnapshot,
  fetchedAt: string,
): TicketSnapshot {
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

export function renderSnapshot(snapshot: TicketSnapshot): string {
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
    ...section(
      "Comments",
      snapshot.comments.map((comment) =>
        [
          `### ${comment.author ?? "unknown"} — ${comment.createdAt}`,
          "",
          comment.body,
        ].join("\n"),
      ),
    ),
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

// Wrapped as a step by the factory, so each fetch is its own memoized step
// record and the World's step history *is* the versioned audit trail — there
// is no jigs-owned snapshot store. On resume the launch-time copy comes back
// from the record and the new fetch is genuinely fresh, which is why a human's
// unblocking reply appears in the later version without any special handling.
export async function fetchSnapshot(issueId: string): Promise<TicketSnapshot> {
  const raw = await fetchIssueSnapshot(issueId);
  const snapshot = toSnapshot(raw, new Date().toISOString());
  console.log(
    `[snapshot] fetched issue=${issueId} identifier=${raw.identifier} state=${snapshot.state} labels=${snapshot.labels.length === 0 ? "none" : snapshot.labels.join(",")} comments=${snapshot.comments.length}`,
  );
  return snapshot;
}
