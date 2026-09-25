/** An operator-readable failure that is safe to construct inside a workflow. */
export class JigsError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "JigsError";
    this.hint = hint;
  }
}
