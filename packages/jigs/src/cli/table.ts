// Every column padded to its widest cell except the last, which would only
// add trailing whitespace nobody can see.
export function formatTable(headers: string[], rows: string[][]): string[] {
  const all = [headers, ...rows];
  const widths = headers.map((_, column) =>
    Math.max(...all.map((row) => (row[column] ?? "").length)),
  );
  return all.map((row) =>
    row
      .map((cell, column) =>
        column === headers.length - 1 ? cell : cell.padEnd(widths[column] ?? 0),
      )
      .join("  "),
  );
}
