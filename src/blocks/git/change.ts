export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "other";

export interface FileChange {
  path: string;
  status: ChangeStatus;
  additions: number;
  deletions: number;
}

export interface ChangeSummary {
  /** Resolved endpoint commits. Files describe the direct difference between their trees. */
  base: string;
  head: string;
  files: FileChange[];
  /** Commits reachable from head but not base, newest first. */
  commits: { sha: string; subject: string }[];
  truncated: boolean;
}

export interface ChangePatch {
  patches: { path: string; text: string }[];
  truncated: boolean;
}

const STATUS_WORDS: Record<string, ChangeStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
};

/** Parse git diff --name-status -z; NUL separators preserve unusual filenames. */
export function parseNameStatus(output: string): Pick<FileChange, "status" | "path">[] {
  const fields = output.split("\0");
  const files: Pick<FileChange, "status" | "path">[] = [];
  for (let i = 0; i < fields.length - 1; ) {
    const code = fields[i++] ?? "";
    let path = fields[i++] ?? "";
    // Renames and copies report old and new paths; the new one is in the tree.
    if (code.startsWith("R") || code.startsWith("C")) path = fields[i++] ?? "";
    files.push({ status: STATUS_WORDS[code[0] ?? ""] ?? "other", path });
  }
  return files;
}

/** Parse git diff --numstat -z. Binary '-' counts contribute zero lines. */
export function parseNumstat(
  output: string,
): Pick<FileChange, "path" | "additions" | "deletions">[] {
  const fields = output.split("\0");
  const files: Pick<FileChange, "path" | "additions" | "deletions">[] = [];
  for (let i = 0; i < fields.length - 1; i++) {
    const row = fields[i] ?? "";
    const first = row.indexOf("\t");
    const second = row.indexOf("\t", first + 1);
    let path = row.slice(second + 1);
    // With -z, a rename has an empty path followed by old and new NUL fields.
    if (path === "") {
      i += 2;
      path = fields[i] ?? "";
    }
    files.push({
      path,
      additions: Number.parseInt(row.slice(0, first), 10) || 0,
      deletions: Number.parseInt(row.slice(first + 1, second), 10) || 0,
    });
  }
  return files;
}

// Beyond this the comment stops being readable and the tally carries the rest.
const MAX_LISTED_FILES = 60;

export function renderChangeSummary(summary: ChangeSummary): string {
  const listed = summary.files.slice(0, MAX_LISTED_FILES);
  const hidden = summary.files.length - listed.length;
  const counts = new Map<ChangeStatus, number>();
  let additions = 0;
  let deletions = 0;
  for (const file of summary.files) {
    counts.set(file.status, (counts.get(file.status) ?? 0) + 1);
    additions += file.additions;
    deletions += file.deletions;
  }
  const tally = [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, count]) => `${count} ${status}`)
    .join(", ");
  const table = listed.map(
    (file) => `${file.status.padEnd(8)} ${file.path} (+${file.additions} / −${file.deletions})`,
  );
  if (hidden > 0) table.push(`… and ${hidden} more`);
  return [
    `**Change** \`${summary.base}\` → \`${summary.head}\``,
    ...summary.commits.map((commit) => `**Commit** \`${commit.subject}\` (${commit.sha})`),
    "",
    `**${summary.files.length} file${summary.files.length === 1 ? "" : "s"} changed** (${tally}) · +${additions} / −${deletions} lines`,
    ...(summary.truncated
      ? ["Summary truncated; file counts and line totals cover only the listed results."]
      : []),
    "",
    "```text",
    ...table,
    "```",
  ].join("\n");
}
