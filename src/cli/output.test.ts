import { afterEach, expect, test, vi } from "vitest";
import {
  columns,
  displayPath,
  formatError,
  formatTable,
  hint,
  hintLines,
  layout,
  note,
  section,
  tone,
} from "./output.ts";
import { layoutProblems } from "./output-layout.ts";

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

test("a hint's backtick commands move to their own line, deeper and without the backticks", () => {
  expect(
    hintLines(
      "prune never stops or kills processes, so stop the service first: `pnpm exec jigs service stop`\nthen retry",
    ),
  ).toEqual([
    "prune never stops or kills processes, so stop the service first:",
    "  pnpm exec jigs service stop",
    "then retry",
  ]);
  expect(hintLines("run `pi`, then choose /login")).toEqual(["run", "  pi", "then choose /login"]);
});

test("an error prints red, with its hint's prose dim and its command cyan beneath it", () => {
  vi.stubEnv("FORCE_COLOR", "1");
  vi.stubEnv("NO_COLOR", undefined);
  const lines = formatError(
    { message: "factory service is still running as pid 25223", hint: "stop it: `jigs stop`" },
    process.stdout,
  );
  expect(lines).toEqual([
    "\u001b[31mjigs: factory service is still running as pid 25223\u001b[39m",
    "  \u001b[2mstop it:\u001b[22m",
    "    \u001b[36mjigs stop\u001b[39m",
  ]);
});

test("sections are one blank line apart, with each body indented under its heading", () => {
  expect(
    layout(
      section("Resources", ["a", "b"]),
      [],
      section(undefined, ["2 removed"]),
      hint("run:", "x"),
    ),
  ).toEqual(["Resources", "  a", "  b", "", "2 removed", "", "run:", "  x"]);
});

test("the layout check names blank-line, indent and dash problems, and allows table columns", () => {
  expect(
    layoutProblems([
      "KIND      ACTION  PATH",
      "worktree  remove  /w",
      "                  previously kept: policy",
    ]),
  ).toEqual([]);
  expect(layoutProblems(["", "a", "", "", "     b — c", ""])).toEqual([
    "starts with a blank line",
    "ends with a blank line",
    'line 4 "": a second blank line',
    'line 5 "     b — c": joined with a dash',
    'line 5 "     b — c": indented by an odd 5',
    'line 5 "     b — c": indented more than a step',
  ]);
});
