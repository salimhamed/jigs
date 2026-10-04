/**
 * An operator-readable failure that is safe to construct inside a workflow.
 *
 * @group Errors and utilities
 */
export class JigsError extends Error {
  /**
   * What the reader can do about it. Quote each command to run in backticks, as in
   * ``stop the service first: `pnpm exec jigs service stop` ``: the CLI prints it on its own line.
   */
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "JigsError";
    this.hint = hint;
  }
}

/**
 * A hint or repair as plain text for logs, error messages and API bodies: every line indented
 * under what failed, the first marked with an arrow. Backticks stay, so a command reads as code.
 *
 * @internal
 */
export function plainHint(text: string, indent = "  "): string {
  return text
    .split("\n")
    .map((line, i) => `${indent}${i === 0 ? "→ " : "  "}${line}`)
    .join("\n");
}
