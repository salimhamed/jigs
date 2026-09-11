import type { PromptRegistry } from "../steps/prompts/registry.ts";
import type { Check, CheckResult } from "./catalog.ts";

// A prompt is a markdown file read at step time, so a syntax error in one is
// invisible until an agent step reaches it — mid-run, after a worktree has
// been cut. This renders every registered prompt with every variable resolved
// to a placeholder, which is the most a check outside a run can do: it cannot
// know what data a block will pass, but it can prove each template parses.
export function promptsCheck(prompts: PromptRegistry): Check {
  return {
    id: "prompts.render",
    label: "prompts render",
    run: async (): Promise<CheckResult> => {
      const failures = prompts.check();
      if (failures.length === 0) return { ok: true };
      return {
        ok: false,
        reason: failures
          .map((failure) => `${failure.name}: ${failure.error}`)
          .join("; "),
        repair:
          "fix the template the error names, then: jigs service restart — a prompt is a file, so the service reads it fresh on the next run",
      };
    },
  };
}
