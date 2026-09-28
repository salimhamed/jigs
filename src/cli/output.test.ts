import { afterEach, expect, test, vi } from "vitest";
import { columns, displayPath, formatTable, note, tone } from "./output.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("columns are padded to the widest cell and the last column is not", () => {
  const lines = formatTable(
    ["RUN", "STATUS"],
    [
      ["01K3", "running"],
      ["01K3ANBZ", "completed"],
    ],
  );
  expect(lines).toEqual(["RUN       STATUS", "01K3      running", "01K3ANBZ  completed"]);
});

test("styled cells align by their visible width", () => {
  vi.stubEnv("FORCE_COLOR", "1");
  vi.stubEnv("NO_COLOR", undefined);
  const lines = columns([
    [tone("failed"), "a"],
    ["kept-longer", "b"],
  ]);
  expect(lines).toEqual(["\u001b[31mfailed\u001b[39m       a", "kept-longer  b"]);
});

test("NO_COLOR prints plain text", () => {
  vi.stubEnv("FORCE_COLOR", undefined);
  vi.stubEnv("NO_COLOR", "1");
  expect(note("skip me")).toBe("skip me");
  expect(tone("failed")).toBe("failed");
});

test("paths under home show as ~ and other URLs are left alone", () => {
  expect(displayPath("file:///home/me/.local/share/jigs/x", "/home/me")).toBe(
    "~/.local/share/jigs/x",
  );
  expect(displayPath("/home/me", "/home/me")).toBe("~");
  expect(displayPath("/home/meadow/x", "/home/me")).toBe("/home/meadow/x");
  expect(displayPath("file:///srv/jigs", "/home/me")).toBe("/srv/jigs");
  expect(displayPath("file://host/share/x", "/home/me")).toBe("file://host/share/x");
  expect(displayPath("https://github.com/acme/api", "/home/me")).toBe(
    "https://github.com/acme/api",
  );
});
