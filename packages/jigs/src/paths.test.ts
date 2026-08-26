import { expect, test } from "vitest";
import { contractHome, expandHome } from "./paths.ts";

const home = "/home/tester";

test("expandHome expands ~ and ~/", () => {
  expect(expandHome("~", home)).toBe(home);
  expect(expandHome("~/Code/repo", home)).toBe("/home/tester/Code/repo");
});

test("expandHome leaves other paths alone", () => {
  expect(expandHome("/opt/repo", home)).toBe("/opt/repo");
  expect(expandHome("relative/repo", home)).toBe("relative/repo");
});

test("contractHome contracts paths under home", () => {
  expect(contractHome("/home/tester/Code/repo", home)).toBe("~/Code/repo");
  expect(contractHome(home, home)).toBe("~");
});

test("contractHome leaves paths outside home absolute", () => {
  expect(contractHome("/opt/repo", home)).toBe("/opt/repo");
  expect(contractHome("/home/tester-other/repo", home)).toBe(
    "/home/tester-other/repo",
  );
});

test("expand/contract round-trips", () => {
  expect(contractHome(expandHome("~/Code/repo", home), home)).toBe(
    "~/Code/repo",
  );
});
