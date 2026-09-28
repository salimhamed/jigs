import { stripVTControlCharacters } from "node:util";

const indentOf = (line: string): number => line.length - line.trimStart().length;

// A table's continuation row starts under one of the row above's columns, which
// need not sit on an even column.
const underColumn = (line: string, above: string): boolean => {
  const at = indentOf(line);
  return above[at - 1] === " " && above[at] !== undefined && above[at] !== " ";
};

/**
 * Where printed output breaks the layout rules in `output.ts`, one message per problem; empty
 * when it follows them. Command tests run it over everything a command prints.
 */
export function layoutProblems(output: readonly string[]): string[] {
  const lines = output.flatMap((line) => stripVTControlCharacters(line).split("\n"));
  const problems: string[] = [];
  if (lines[0] === "") problems.push("starts with a blank line");
  if (lines.length > 0 && lines.at(-1) === "") problems.push("ends with a blank line");
  let above: string | undefined;
  lines.forEach((line, i) => {
    const where = `line ${i + 1} ${JSON.stringify(line)}`;
    if (line === "") {
      if (lines[i - 1] === "") problems.push(`${where}: a second blank line`);
      return;
    }
    if (/\s$/.test(line)) problems.push(`${where}: trailing whitespace`);
    if (line.includes(" — ")) problems.push(`${where}: joined with a dash`);
    if (above === undefined || !underColumn(line, above)) {
      const indent = indentOf(line);
      if (indent % 2 !== 0) problems.push(`${where}: indented by an odd ${indent}`);
      if (indent > indentOf(above ?? "") + 2) problems.push(`${where}: indented more than a step`);
    }
    above = line;
  });
  return problems;
}
