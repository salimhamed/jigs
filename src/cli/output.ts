import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { type InspectColor, stripVTControlCharacters, styleText } from "node:util";

// Every command prints to stdout, so styling asks stdout whether it can show
// color: NO_COLOR, a pipe or a file all get plain text.
const paint = (format: InspectColor | InspectColor[], text: string): string =>
  styleText(format, text, { stream: process.stdout, validateStream: true });

/** A section title, such as a run ID above that run's table. */
export const heading = (text: string): string => paint("bold", text);

/** Secondary text: an explanation, a caveat or a pointer the reader can skip. */
export const note = (text: string): string => paint("dim", text);

/** A command for the reader to copy and run. */
export const command = (text: string): string => paint("cyan", text);

const TONES: Record<string, InspectColor> = {
  completed: "green",
  ok: "green",
  removed: "green",
  release: "green",
  released: "green",
  running: "yellow",
  pending: "yellow",
  waiting: "yellow",
  kept: "yellow",
  keep: "yellow",
  failed: "red",
  FAIL: "red",
  cancelled: "magenta",
};

/**
 * A state word, colored by what it means: green done, yellow in progress or held, red failed or
 * unreachable, magenta cancelled, dim skipped. Other words stay plain.
 */
export const tone = (word: string): string => {
  const color = TONES[word];
  return color === undefined ? word : paint(color, word);
};

/**
 * Rows with each column padded to its widest cell, two spaces apart. Cells may already be styled;
 * alignment counts only the visible characters. The last column is not padded, since trailing
 * spaces would only be invisible.
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
      .join("  "),
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
