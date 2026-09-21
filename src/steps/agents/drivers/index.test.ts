import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { drivers } from "./index.ts";

test("every registered driver declares its operational contract and documentation", () => {
  const guide = readFileSync(
    new URL("../../../../site/guide/models-and-harnesses.md", import.meta.url),
    "utf8",
  );
  for (const driver of Object.values(drivers)) {
    expect(driver.runtimeChecks()).not.toHaveLength(0);
    expect(driver.authChecks()).not.toHaveLength(0);
    expect(driver.envAllowlist).toBeInstanceOf(Array);
    if (driver.family === "harness") {
      expect(driver.sessionPointer).toEqual({
        providerKey: expect.any(String),
        field: expect.any(String),
      });
    } else {
      expect(driver.sessionPointer).toBeUndefined();
    }
    const headings = [...guide.matchAll(/^## (.+)$/gm)].map((match) =>
      match[1]?.toLowerCase().replaceAll(" ", "-"),
    );
    expect(headings).toContain(driver.docsAnchor);
  }
});

test("Claude reports its provider cost and Codex has no cost estimate", () => {
  const generation = {
    text: "done",
    usage: {
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokenDetails: { textTokens: 2, reasoningTokens: 0 },
    },
    providerMetadata: { "claude-code": { costUsd: 0.42 } },
  };
  expect(drivers.claude.cost(generation)).toBe(0.42);
  expect(drivers.codex.cost()).toBeUndefined();
});
