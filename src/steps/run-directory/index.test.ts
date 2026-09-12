import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createRunDirectory, removeRunDirectory } from "./index.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "jigs-directory-test-"));
  vi.stubEnv("XDG_DATA_HOME", root);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

test("re-entering a run preserves its files while other runs stay isolated", async () => {
  const first = { workflowRunId: "wrun_first" };
  const second = { workflowRunId: "wrun_second" };
  const firstDirectory = await createRunDirectory(first);
  const secondDirectory = await createRunDirectory(second);
  await writeFile(path.join(firstDirectory, "evidence.txt"), "saved investigation");
  expect(await createRunDirectory(first)).toBe(firstDirectory);
  expect(await readFile(path.join(firstDirectory, "evidence.txt"), "utf8")).toBe(
    "saved investigation",
  );
  await removeRunDirectory(second);
  await expect(stat(secondDirectory)).rejects.toThrow();
  expect(await readFile(path.join(firstDirectory, "evidence.txt"), "utf8")).toBe(
    "saved investigation",
  );
  await removeRunDirectory(first);
  await removeRunDirectory(first);
  await expect(stat(firstDirectory)).rejects.toThrow();
});

test.each(["", "..", "../other", "/tmp/other", "run/other", "run\\other"])(
  "rejects unsafe run IDs: %s",
  async (workflowRunId) => {
    await expect(createRunDirectory({ workflowRunId })).rejects.toThrow("Invalid workflow run ID");
    await expect(removeRunDirectory({ workflowRunId })).rejects.toThrow("Invalid workflow run ID");
  },
);
