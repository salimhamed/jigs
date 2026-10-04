import { expect, test } from "vitest";
import { factorySlug } from "./paths.ts";

test("factorySlug embeds the dirname and is stable for equal paths", () => {
  const slug = factorySlug("/home/x/factories/acme");
  expect(slug).toMatch(/^acme-[0-9a-f]{8}$/);
  expect(factorySlug("/home/x/factories/acme")).toBe(slug);
});

test("factorySlug distinguishes same-named factories at different paths", () => {
  expect(factorySlug("/a/factory")).not.toBe(factorySlug("/b/factory"));
});
