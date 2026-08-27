import { claude } from "jigs/steps";
import { z } from "zod";
import { agentOrHalt } from "../src/steps/jit";
import { claimTicket } from "../src/suspension/claim";

export const jitDemoInputs = z.object({
  issueId: z.uuid(),
});

type JitDemoInputs = z.output<typeof jitDemoInputs> & { triggerId: string };

// JIT acceptance vehicle: the declared MCP server cannot start, so the step
// halts needs-human before any agent turn is burned. Every human reply
// re-runs the step from zero — and fails the same way, which is what makes
// the second attempt observable in the log.
export async function jitDemoPipeline(inputs: JitDemoInputs) {
  "use workflow";

  const claim = await claimTicket(inputs.issueId);
  const result = await agentOrHalt(claim, {
    harness: claude({
      model: "sonnet",
      mcpServers: {
        linear: {
          command: "definitely-not-a-binary",
          probe: { tool: "get_probe_token" },
        },
      },
    }),
    cwd: "/tmp",
    prompt: "never reached — the JIT check fails first",
  });
  return { text: result.text };
}
