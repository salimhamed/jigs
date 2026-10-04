import { expect, test } from "vitest";
import { claudeAuthCheck } from "./checks.ts";

// The live half of the auth check: the unit tests feed recorded payloads, this
// one asks the machine's real login.
test("the real claude CLI reports a subscription login", async () => {
  expect(await claudeAuthCheck().run()).toEqual({ ok: true });
});
