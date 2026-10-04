import { expect, test } from "vitest";
import { codexAuthCheck } from "./checks.ts";

// The live half of the auth check: the unit tests feed recorded payloads, this
// one reads the machine's real login.
test("~/.codex/auth.json reports a subscription login", async () => {
  expect(await codexAuthCheck().run()).toEqual({ ok: true });
});
