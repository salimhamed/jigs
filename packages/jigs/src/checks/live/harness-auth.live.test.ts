import { expect, test } from "vitest";
import { claudeAuthCheck, codexAuthCheck } from "../harnesses.ts";

// The live half of the harness auth checks: the unit tests feed recorded
// payloads, this one asks the machine's real logins.
test("the real claude CLI and ~/.codex/auth.json both report subscription logins", async () => {
  expect(await claudeAuthCheck().run()).toEqual({ ok: true });
  expect(await codexAuthCheck().run()).toEqual({ ok: true });
});
