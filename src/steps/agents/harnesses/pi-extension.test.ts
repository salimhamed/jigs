import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { writePiSubmitResultExtension } from "./pi-extension.ts";
import { makeTmpDir, removeTmpDir } from "./test-fixtures.ts";

let tmp: string | undefined;
afterEach(() => {
  if (tmp !== undefined) removeTmpDir(tmp);
});

test("submit_result extension is written inside the invocation home with the wire schema", () => {
  tmp = makeTmpDir();
  const schema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  };
  const extension = writePiSubmitResultExtension(tmp, schema);

  expect(extension).toBe(path.join(tmp, "submit-result.ts"));
  const source = readFileSync(extension, "utf8");
  expect(source).toContain('name: "submit_result"');
  expect(source).toContain('constrainedSampling: { type: "json_schema", strict: "require" }');
  expect(source).toContain(JSON.stringify(schema));
  expect(source).toContain("details: params");
});
