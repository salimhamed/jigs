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
