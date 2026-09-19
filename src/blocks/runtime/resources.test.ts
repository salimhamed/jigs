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

test("kind overflow identifies the kind and both encoded components", () => {
  const kind = "界".repeat(40);
  let failure: unknown;
  try {
    resourceAttribute({ kind, identity: "x", url: "https://example.test/report" });
  } catch (error) {
    failure = error;
  }
  expect((failure as JigsError).message).toContain("resource kind is too long");
  expect((failure as JigsError).message).toContain(
    "encoded kind uses 360 characters from 120 UTF-8 bytes",
  );
  expect((failure as JigsError).message).toContain(
    "encoded identity uses 1 character from 1 UTF-8 byte",
  );
  expect((failure as JigsError).hint).toContain("shorten the resource kind, identity, or both");
});

test("identity overflow identifies the identity and both encoded components", () => {
  const identity = "界".repeat(40);
  let failure: unknown;
  try {
    resourceAttribute({ kind: "report", identity, url: "https://example.test/report" });
  } catch (error) {
    failure = error;
  }
  expect((failure as JigsError).message).toContain("resource identity is too long");
  expect((failure as JigsError).message).toContain(
    "encoded kind uses 6 characters from 6 UTF-8 bytes",
  );
  expect((failure as JigsError).message).toContain(
    "encoded identity uses 360 characters from 120 UTF-8 bytes",
  );
  expect((failure as JigsError).message).toContain(`limit ${RUN_ATTRIBUTE_KEY_LIMIT}`);
  expect((failure as JigsError).hint).toContain("never truncates");
});

test("combined overflow reports the shared encoded-component budget", () => {
  let failure: unknown;
  try {
    resourceAttribute({
      kind: "k".repeat(120),
      identity: "i".repeat(120),
      url: "https://example.test/report",
    });
  } catch (error) {
    failure = error;
  }
  expect((failure as JigsError).message).toContain("kind and identity are too long together");
  expect((failure as JigsError).message).toContain("encoded kind uses 120 characters");
  expect((failure as JigsError).message).toContain("encoded identity uses 120 characters");
  expect((failure as JigsError).message).toContain("237-character budget");
  expect((failure as JigsError).hint).toContain("encoded lengths total at most 237 characters");
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
