import { expect, test, vi } from "vitest";
import { withCodexAppServer } from "../drivers/codex-support.ts";

const close = vi.fn(async () => {});

vi.mock("ai-sdk-provider-codex-cli", () => ({
  createCodexAppServer: () => ({ close }),
}));

test("withCodexAppServer closes the provider on success AND on throw", async () => {
  await expect(withCodexAppServer(async () => "ok")).resolves.toBe("ok");
  expect(close).toHaveBeenCalledTimes(1);

  await expect(withCodexAppServer(async () => Promise.reject(new Error("boom")))).rejects.toThrow(
    "boom",
  );
  expect(close).toHaveBeenCalledTimes(2);
});
