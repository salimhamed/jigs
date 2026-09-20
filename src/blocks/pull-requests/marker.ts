/** The work recorded by a hidden marker in a pull request comment. */
export type MarkerKind = "reply" | "completion" | "status";

/**
 * Why a `status` note was written, so one note never silences another.
 * `merge` and `ci` stand a commit down; `merge-retry` only records that the
 * refusal was already reported, and leaves the commit merge-ready.
 */
export type StatusReason = "merge" | "ci" | "merge-retry";

const KINDS = new Set<string>(["reply", "completion", "status"]);
const REASONS = new Set<string>(["merge", "ci", "merge-retry"]);

/** Hidden progress metadata stored in a pull request comment. */
export interface PullRequestMarker {
  /**
   * The continuation identity. It survives run replacement, so a later run
   * answering for the same scope sees this work as its own and does not redo
   * it. Another scope's marker means "some jigs workflow wrote this", never
   * "my work is done".
   */
  scope: string;
  /** The run that wrote it. Provenance for a reader; never matched on. */
  run: string;
  /**
   * `reply` answers the thing named by `source`, `completion` records work
   * finished for it, and `status` is a note about a commit — a stand-down
   * after a refused merge, a CI failure jigs could not repair, or a merge
   * refused for a state that will pass.
   */
  kind: MarkerKind;
  /** Required on a `status` marker, meaningless on any other. */
  reason?: StatusReason;
  /** What this answers: a comment as `id@updatedAt`, or a commit sha. */
  source?: string;
}

const OPEN = "<!-- jigs:v1 ";
const CLOSE = " -->";

// The payload is JSON, so quoting, newlines and every other awkward character
// are JSON.stringify's problem and not this module's. One sequence still
// matters: `-->` ends the HTML comment wherever it appears, so a value
// carrying it would break the marker open.
const TERMINATOR = "-->";

/**
 * The one rule a caller-supplied scope has to keep. Checked where a scope
 * enters, so the error names the scope rather than the comment it broke.
 */
export function assertUsableScope(scope: string): void {
  if (scope === "") throw new Error("a marker scope cannot be empty");
  if (scope.includes(TERMINATOR)) {
    throw new Error(`a marker scope cannot contain "${TERMINATOR}": ${scope}`);
  }
}

/** The hidden line jigs appends to everything it posts on a pull request. */
export function renderMarker(marker: PullRequestMarker): string {
  if (marker.kind === "status" && marker.reason === undefined) {
    throw new Error("a status marker has to say why it was written");
  }
  assertUsableScope(marker.scope);
  const payload = JSON.stringify({
    scope: marker.scope,
    run: marker.run,
    kind: marker.kind,
    ...(marker.reason === undefined ? {} : { reason: marker.reason }),
    ...(marker.source === undefined ? {} : { source: marker.source }),
  });
  if (payload.includes(TERMINATOR)) {
    throw new Error(`a marker value cannot contain "${TERMINATOR}": ${payload}`);
  }
  return `${OPEN}${payload}${CLOSE}`;
}

/**
 * The body as posted: the text a human reads, then the markers. At least one,
 * always — an unmarked comment of jigs' own reads as human feedback and buys
 * itself a revision round.
 */
export function markBody(body: string, markers: PullRequestMarker[]): string {
  if (markers.length === 0) {
    throw new Error("every comment jigs posts on a pull request carries a marker");
  }
  return [body, ...markers.map(renderMarker)].join("\n\n");
}

// Lazy up to the first `-->`, which renderMarker guarantees is the terminator.
const MARKER = /<!--\s*jigs:v1\s([\s\S]*?)-->/g;

// GitHub's "Quote reply" copies the comment's raw markdown, markers and all,
// as `> ` lines under the human's own words. A quoted marker is a quotation,
// not a claim, so a marker is only jigs' own where its line is not quoted.
function quoted(body: string, at: number): boolean {
  const line = body.slice(body.lastIndexOf("\n", at) + 1, at);
  return /^[ \t]*>/.test(line);
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** Every marker in one comment body, in the order they appear. */
export function parseMarkers(body: string): PullRequestMarker[] {
  const markers: PullRequestMarker[] = [];
  for (const match of body.matchAll(MARKER)) {
    const payload = match[1];
    if (payload === undefined || quoted(body, match.index)) continue;
    let found: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(payload);
      if (typeof parsed !== "object" || parsed === null) continue;
      found = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const scope = text(found.scope);
    const kind = text(found.kind);
    // A marker missing either is not one jigs can act on, and treating it as
    // one would let a malformed body claim work as done. A status marker that
    // does not say why it was written is the same case. Anything else in the
    // payload is a field this version does not know, and is left alone.
    if (scope === undefined || scope === "" || kind === undefined || !KINDS.has(kind)) continue;
    const reason = text(found.reason);
    const known = reason !== undefined && REASONS.has(reason);
    if (kind === "status" && !known) continue;
    const source = text(found.source);
    markers.push({
      scope,
      run: text(found.run) ?? "",
      kind: kind as MarkerKind,
      ...(known ? { reason: reason as StatusReason } : {}),
      ...(source === undefined ? {} : { source }),
    });
  }
  return markers;
}

/**
 * Whether jigs wrote this comment, whatever scope wrote it. This is the whole
 * self guard: the author login cannot serve, because a factory running on its
 * operator's token posts as the operator.
 */
export function carriesMarker(body: string): boolean {
  return parseMarkers(body).length > 0;
}

/** What a scope has already done on this pull request, read off the comments. */
export interface MarkerLedger {
  /** Sources this scope answered or completed: a comment version, or a commit. */
  answered: ReadonlySet<string>;
  /** Commits this scope wrote a status note about, kept apart by why. */
  settled: Readonly<Record<StatusReason, ReadonlySet<string>>>;
}

/** Read the completed work and settled commits recorded for one continuation scope. */
export function readLedger(bodies: Iterable<string>, scope: string): MarkerLedger {
  const answered = new Set<string>();
  const settled = {
    merge: new Set<string>(),
    ci: new Set<string>(),
    "merge-retry": new Set<string>(),
  };
  for (const body of bodies) {
    for (const marker of parseMarkers(body)) {
      if (marker.scope !== scope || marker.source === undefined) continue;
      if (marker.kind !== "status") answered.add(marker.source);
      else if (marker.reason !== undefined) settled[marker.reason].add(marker.source);
    }
  }
  return { answered, settled };
}

/**
 * What a comment is, as a marker names it. The edit time is part of it: a
 * reviewer who edits a comment has said something new, and an answer to the
 * old text no longer answers it.
 */
export function commentSource(comment: { id: number; updatedAt: string }): string {
  return `${comment.id}@${comment.updatedAt}`;
}

/** The default continuation identity: the workflow, and what it is working on. */
export function pullRequestScope(workflow: string, subject: string): string {
  const scope = `${workflow}/${subject}`;
  assertUsableScope(scope);
  return scope;
}
