// The per-activation copy of a Linear ticket (ADR 0002). Contents are fixed:
// title, description, labels, comments, blocker/blocking relations, attached
// links, sub-issue ids/titles — no file attachments, and deep or live reads
// are opt-in through a per-step Linear MCP server rather than widened here.
// `branchName` is Linear's gitBranchName, the worktree branch default. Every
// step in one activation reads the same snapshot value.

import { fetchIssueSnapshot, type RawIssueSnapshot } from "../providers/linear";

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
  version: number;
  fetchedAt: string;
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  branchName: string;
  state: string;
  creator: { id: string; name: string } | null;
  labels: string[];
  comments: SnapshotComment[];
  blockedBy: TicketRef[];
  blocks: TicketRef[];
  links: TicketLink[];
  subIssues: TicketRef[];
};

export function toSnapshot(
  raw: RawIssueSnapshot,
  version: number,
  fetchedAt: string,
): TicketSnapshot {
  return {
    version,
    fetchedAt,
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    description: raw.description ?? "",
    url: raw.url,
    branchName: raw.branchName,
    state: raw.state.name,
    creator: raw.creator,
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

async function fetchSnapshot(
  issueId: string,
  version: number,
): Promise<TicketSnapshot> {
  "use step";
  const raw = await fetchIssueSnapshot(issueId);
  console.log(
    `[snapshot] fetched issue=${issueId} identifier=${raw.identifier} version=${version}`,
  );
  return toSnapshot(raw, version, new Date().toISOString());
}

export interface TicketSnapshots {
  versions: TicketSnapshot[];
  refresh(): Promise<TicketSnapshot>;
  latest(): TicketSnapshot;
}

/**
 * The versioned snapshot log for one ticket, held workflow-side.
 *
 * Each `refresh()` awaits one memoized step, so the World's step history *is*
 * the versioned audit trail — there is no jigs-owned snapshot store. A body
 * that suspends and refreshes again after the resume gets the launch-time
 * copy back from the record and a genuinely fresh copy for the new
 * activation, which is why a human's unblocking reply appears in the later
 * version without any special handling. The version number comes from the
 * array length rather than a clock, so replay stays deterministic.
 */
export function ticketSnapshots(issueId: string): TicketSnapshots {
  const versions: TicketSnapshot[] = [];
  return {
    versions,
    async refresh() {
      const snapshot = await fetchSnapshot(issueId, versions.length + 1);
      versions.push(snapshot);
      return snapshot;
    },
    latest() {
      const snapshot = versions.at(-1);
      if (snapshot === undefined) {
        throw new Error(`no snapshot fetched yet for issue ${issueId}`);
      }
      return snapshot;
    },
  };
}
