import { CliError } from "../errors.ts";

// One line per step, stopping at the first that fails: what `init` bought by
// printing the commands instead of running them — a failure the human can
// see and name — kept by the verbs that run them.

export interface Step<Name extends string> {
  name: Name;
  status: "ok" | "failed" | "skipped";
  durationMs: number;
  detail?: string;
  repair?: string;
}

export class StepFailed extends Error {}

export type Note = (detail: string) => void;

export interface Runner<Name extends string> {
  steps: Step<Name>[];
  run<T>(name: Name, fn: (note: Note) => Promise<T> | T): Promise<T>;
  skip(name: Name, detail: string): void;
}

export function stepRunner<Name extends string>(
  out: (line: string) => void,
): Runner<Name> {
  const steps: Step<Name>[] = [];
  return {
    steps,
    async run(name, fn) {
      const started = Date.now();
      let detail: string | undefined;
      try {
        const value = await fn((text) => {
          detail = text;
        });
        const durationMs = Date.now() - started;
        steps.push({ name, status: "ok", durationMs, detail });
        out(
          `ok   ${name} (${formatDuration(durationMs)})${detail === undefined ? "" : ` — ${detail}`}`,
        );
        return value;
      } catch (err) {
        const durationMs = Date.now() - started;
        const message = err instanceof Error ? err.message : String(err);
        const repair = err instanceof CliError ? err.hint : undefined;
        steps.push({
          name,
          status: "failed",
          durationMs,
          detail: message,
          repair,
        });
        out(`FAIL ${name}: ${message.split("\n")[0]}`);
        if (repair !== undefined) out(`  → ${repair}`);
        throw new StepFailed(message);
      }
    },
    skip(name, detail) {
      steps.push({ name, status: "skipped", durationMs: 0, detail });
      out(`skip ${name} — ${detail}`);
    },
  };
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export const indent =
  (out: (line: string) => void) =>
  (line: string): void =>
    out(`  ${line}`);
