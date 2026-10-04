import { expect, test } from "vitest";
import { harnesses } from "../workflow/agents/harness-config.ts";
import { harnessUsers } from "./harnesses.ts";

test("harness users are derived from each workflow's agents", () => {
  expect(
    harnessUsers({
      hello: {},
      review: {
        requires: {
          agents: {
            reviewer: harnesses.claude({ model: "opus" }),
            second: harnesses.claude({ model: "sonnet" }),
          },
        },
      },
      ship: {
        requires: {
          agents: {
            builder: harnesses.codex({ model: "gpt-5.5" }),
            reviewer: harnesses.claude({ model: "opus" }),
          },
        },
      },
    }),
  ).toEqual(
    new Map([
      ["claude", ["review", "ship"]],
      ["codex", ["ship"]],
    ]),
  );
  expect(harnessUsers({ hello: {} })).toEqual(new Map());
});
