/**
 * The styling and layout every command's human output shares.
 *
 * @remarks
 * The layout rules, which `layoutProblems` in `output-layout.ts` checks in the command tests:
 *
 * - Output is sections separated by one blank line, with no blank line at the start or end
 *   and never two in a row. {@link layout} joins sections this way.
 * - A section is a bold heading with no trailing colon, then its body indented two spaces
 *   ({@link section}). Nested bodies step in two more spaces each. A section without a
 *   heading starts at the left edge.
 * - A run's heading is its ID then its status, two spaces apart ({@link runHeading}).
 * - Key/value facts are aligned {@link columns} with lowercase keys and no colons. A
 *   parenthetical detail is dim and follows its value after one space ({@link detail}).
 * - A command for the reader to run is cyan and on its own line, two spaces deeper than the
 *   dim line that introduces it ({@link hint}). Hints and check repairs written as text mark
 *   commands with backticks, which {@link hintLines} lays out the same way.
 * - A summary line of counts, when a command prints one, comes last after one blank line:
 *   `2 removed, 1 kept, 0 failed`.
 * - One fact per line. Sentences are not joined with dashes or semicolons.
 */

import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { type InspectColor, stripVTControlCharacters, styleText } from "node:util";

type Stream = NodeJS.WriteStream;

// Every command prints to stdout, so styling asks stdout whether it can show
// color: NO_COLOR, a pipe or a file all get plain text.
const paint = (
  format: InspectColor | InspectColor[],
  text: string,
  stream: Stream = process.stdout,
) => styleText(format, text, { stream, validateStream: true });

/** A section title, such as a run ID above that run's table. */
export const heading = (text: string): string => paint("bold", text);

/** Secondary text: an explanation, a caveat or a pointer the reader can skip. */
export const note = (text: string, stream?: Stream): string => paint("dim", text, stream);

/** A command for the reader to copy and run. */
export const command = (text: string, stream?: Stream): string => paint("cyan", text, stream);

/** A dim parenthetical that follows a value after one space. */
export const detail = (text: string): string => note(`(${text})`);

const TONES: Record<string, InspectColor> = {
  completed: "green",
  ok: "green",
  removed: "green",
  remove: "green",
  released: "green",
  running: "yellow",
  pending: "yellow",
  waiting: "yellow",
  suspended: "yellow",
  kept: "yellow",
  keep: "yellow",
  failed: "red",
  FAIL: "red",
  unreachable: "red",
  cancelled: "magenta",
  skip: "dim",
  skipped: "dim",
};

/**
 * A state word, colored by what it means: green done, yellow in progress or held, red failed or
 * unreachable, magenta cancelled, dim skipped. Other words stay plain.
 */
export const tone = (word: string): string => {
  const color = TONES[word];
  return color === undefined ? word : paint(color, word);
};

const INDENT = "  ";

/** Lines moved one indent step to the right; blank lines stay blank. */
export const indent = (lines: readonly string[]): string[] =>
  lines.map((line) => (line === "" ? "" : `${INDENT}${line}`));

/** A heading over its indented body, or the body alone at the left edge without one. */
export const section = (title: string | undefined, body: readonly string[]): string[] =>
  title === undefined ? [...body] : [heading(title), ...indent(body)];

/** Sections joined by one blank line each; empty sections are dropped. */
export const layout = (...sections: ReadonlyArray<readonly string[]>): string[] =>
  sections
    .filter((lines) => lines.length > 0)
    .flatMap((lines, i) => (i === 0 ? lines : ["", ...lines]));

/** A run's heading: its ID, then its status. */
export const runHeading = (runId: string, status: string): string =>
  `${heading(runId)}  ${tone(status)}`;

/** A dim line that says what to do, then each command on its own line beneath it. */
export const hint = (label: string, commands: string | readonly string[]): string[] => [
  note(label),
  ...indent((typeof commands === "string" ? [commands] : commands).map((text) => command(text))),
];

/**
 * Hint or repair text as lines: prose stays dim, and each backtick-quoted command moves to its
 * own line, one step deeper, without the backticks. A parenthetical right after a command stays
 * beside it, dim. A line with an unpaired backtick prints as plain prose.
 *
 * @example
 * ```text
 * "stop the service first: `pnpm exec jigs service stop` (in ~/factory)" prints as
 * stop the service first:
 *   pnpm exec jigs service stop (in ~/factory)
 * ```
 */
export function hintLines(text: string, stream: Stream = process.stdout): string[] {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const parts = line.split("`");
    if (parts.length % 2 === 0) {
      if (line.trim() !== "") lines.push(note(line.trim(), stream));
      continue;
    }
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        lines.push(`${INDENT}${command(part, stream)}`);
        return;
      }
      let rest = part;
      const aside = i === 0 ? null : /^\s*(\([^)]*\))/.exec(rest);
      if (aside?.[1] !== undefined) {
        lines[lines.length - 1] += ` ${note(aside[1], stream)}`;
        rest = rest.slice(aside[0].length);
      }
      // Prose after a command reads on without the punctuation that tied it on.
      const prose = (i === 0 ? rest : rest.replace(/^[\s,;.]+/, "")).trim();
      if (prose !== "") lines.push(note(prose, stream));
    });
  }
  return lines;
}

/** How the CLI prints a failure: the message in red, then its hint indented beneath it. */
export function formatError(
  error: { message: string; hint?: string },
  stream: Stream = process.stderr,
): string[] {
  const red = (line: string) => (line === "" ? "" : paint("red", line, stream));
  const [first = "", ...rest] = error.message.split("\n");
  return [
    red(`jigs: ${first}`),
    ...rest.map(red),
    ...indent(error.hint === undefined ? [] : hintLines(error.hint, stream)),
  ];
}

/**
 * Rows with each column padded to its widest cell, two spaces apart. Cells may already be styled;
 * alignment counts only the visible characters. Lines carry no trailing spaces, which would only
 * be invisible.
 */
export function columns(rows: string[][]): string[] {
  const width = (cell: string | undefined) => stripVTControlCharacters(cell ?? "").length;
  const count = Math.max(0, ...rows.map((row) => row.length));
  const widths = Array.from({ length: count }, (_, column) =>
    Math.max(...rows.map((row) => width(row[column]))),
  );
  return rows.map((row) =>
    row
      .map((cell, column) =>
        column === row.length - 1 ? cell : cell + " ".repeat((widths[column] ?? 0) - width(cell)),
      )
      .join("  ")
      .trimEnd(),
  );
}

/** {@link columns} under a bold header row. */
export function formatTable(headers: string[], rows: string[][]): string[] {
  const [header = "", ...body] = columns([headers, ...rows]);
  return [heading(header), ...body];
}

/** A `file:` URL or absolute path as the reader would type it, with `~` for the home directory. */
export function displayPath(target: string, home = homedir()): string {
  const local = target.startsWith("file:") ? localPath(target) : target;
  if (local === home) return "~";
  return local.startsWith(`${home}/`) ? `~${local.slice(home.length)}` : local;
}

// A file URL naming another host has no local path, so it prints as given.
function localPath(url: string): string {
  try {
    return fileURLToPath(url);
  } catch {
    return url;
  }
}
