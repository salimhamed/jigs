import { writeFileSync } from "node:fs";
import path from "node:path";
import type { OutputJsonSchema } from "../../../blocks/agents/output-schema.ts";

/** Write the one structured-result tool Pi may load for this request. */
export function writePiSubmitResultExtension(home: string, schema: OutputJsonSchema): string {
  const extension = path.join(home, "submit-result.ts");
  writeFileSync(
    extension,
    `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "submit_result",
    label: "Submit result",
    description: "Submit the final structured answer.",
    promptSnippet: "Submit the final structured answer",
    promptGuidelines: ["Use submit_result as your final action and do not answer afterward."],
    parameters: Type.Unsafe(${JSON.stringify(schema)}),
    constrainedSampling: { type: "json_schema", strict: "require" },
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: "Structured result submitted" }],
        details: params,
        terminate: true,
      };
    },
  });
}
`,
  );
  return extension;
}
