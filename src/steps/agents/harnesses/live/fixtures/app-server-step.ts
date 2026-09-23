// Subprocess fixture for the clean-exit acceptance criterion: runs one
// app-server step through withCodexAppServer and must EXIT — a hung event
// loop (the bug the finally-close exists for) makes the parent test fail on
// deadline instead of hanging vitest. The result goes to a file, not stdout —
// the provider writes its own noise there.
// argv: <cwd> <codexHome> <resultFile>
import { writeFileSync } from "node:fs";
import { generateText } from "ai";
import { codexAppServerStepSettings, withCodexAppServer } from "../../../drivers/codex-support.ts";
import { harnessEnv } from "../../env.ts";

const [cwd, codexHome, resultFile] = process.argv.slice(2);
if (cwd === undefined || codexHome === undefined || resultFile === undefined) {
  console.error("usage: node app-server-step.ts <cwd> <codexHome> <resultFile>");
  process.exit(2);
}

const result = await withCodexAppServer(async (provider) => {
  const model = provider(
    "gpt-5.6-luna",
    codexAppServerStepSettings({
      cwd,
      codexHome,
      env: harnessEnv([]),
      approvalPolicy: "never",
      sandboxPolicy: "workspace-write",
      effort: "low",
      autoApprove: true,
    }),
  );
  const generation = await generateText({
    model,
    prompt: "Reply with exactly the word ACK and nothing else.",
  });
  const meta = generation.providerMetadata?.["codex-app-server"] as
    | { threadId?: string }
    | undefined;
  return { text: generation.text, threadId: meta?.threadId };
});

writeFileSync(resultFile, JSON.stringify(result));
