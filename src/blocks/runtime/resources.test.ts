import { expect, test } from "vitest";
import type { JigsError } from "../errors.ts";
import {
  RUN_ATTRIBUTE_KEY_LIMIT,
  RUN_ATTRIBUTE_VALUE_BYTE_LIMIT,
  resourceAttribute,
  resourcesFromAttributes,
} from "./resources.ts";

test("kind and identity round-trip through a stable attribute key", () => {
  const resource = {
    kind: "custom/report",
    identity: "quarter:東京/2026",
    url: "https://example.test/reports/2026?q=%E6%9D%B1%E4%BA%AC",
  };
  const attribute = resourceAttribute(resource);

  expect(attribute.key).toContain("custom%2Freport:quarter%3A%E6%9D%B1%E4%BA%AC%2F2026");
  expect(resourcesFromAttributes({ [attribute.key]: attribute.value })).toEqual([resource]);
});

test("decoding ignores unrelated and malformed reserved attributes", () => {
  expect(
    resourcesFromAttributes({
      phase: "complete",
      $parentRunId: "wrun_parent",
      "$jigs.resource.v1:not-separated": "https://example.test",
      "$jigs.resource.v1:report:bad%XX": "https://example.test",
      "$jigs.resource.v1:report:good": "not a URL",
    }),
  ).toEqual([]);
});

test("identity overflow reports bytes and the encoded key without truncating", () => {
  const identity = "界".repeat(40);
  let failure: unknown;
  try {
    resourceAttribute({ kind: "report", identity, url: "https://example.test/report" });
  } catch (error) {
    failure = error;
  }
  expect((failure as JigsError).message).toContain("120 UTF-8 bytes");
  expect((failure as JigsError).message).toContain(`limit ${RUN_ATTRIBUTE_KEY_LIMIT}`);
  expect((failure as JigsError).hint).toContain("never truncates");
});

test("URL overflow counts UTF-8 bytes rather than characters", () => {
  const url = `https://example.test/${"é".repeat(120)}`;
  expect(url.length).toBeLessThan(RUN_ATTRIBUTE_VALUE_BYTE_LIMIT);
  expect(() => resourceAttribute({ kind: "report", identity: "unicode", url })).toThrow(
    `261 UTF-8 bytes (limit ${RUN_ATTRIBUTE_VALUE_BYTE_LIMIT})`,
  );
});

test("the maximum single-resource event stays well below the 8 KiB attr_set limit", () => {
  const prefixLength = resourceAttribute({
    kind: "x",
    identity: "x",
    url: "https://example.test",
  }).key.length;
  const identity = "x".repeat(RUN_ATTRIBUTE_KEY_LIMIT - prefixLength);
  const url = `https://example.test/${"x".repeat(
    RUN_ATTRIBUTE_VALUE_BYTE_LIMIT - new TextEncoder().encode("https://example.test/").length,
  )}`;
  const { key, value } = resourceAttribute({ kind: "x", identity, url });
  const eventData = {
    changes: [{ key, value }],
    writer: { type: "step", stepId: "step_01TEST", attempt: 999 },
    allowReservedAttributes: true,
  };
  expect(new TextEncoder().encode(JSON.stringify(eventData)).length).toBeLessThan(8192);
});
