import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { makeFactoryRepo, makeTmpDir, removeTmpDir } from "../../test-fixtures.ts";
import { connectHub } from "./hub.ts";

let tmp: string;
let factory: string;
let lines: string[];

beforeEach(() => {
  tmp = makeTmpDir();
  factory = makeFactoryRepo(tmp);
  lines = [];
});
afterEach(() => {
  removeTmpDir(tmp);
});

const deps = () => ({ cwd: factory, out: (line: string) => lines.push(line) });
const read = (file: string) => readFileSync(path.join(factory, file), "utf8");
const write = (file: string, text: string) => writeFileSync(path.join(factory, file), text);

test("connect points the config at the hub and replaces the token in .env", () => {
  write(
    "jigs.config.ts",
    `export default defineFactory({\n  hub: { url: "https://hub.example.com" },\n  workflows: {},\n});\n`,
  );
  write(".env", "WORKFLOW_POSTGRES_URL=postgres://x\nJIGS_HUB_TOKEN=\nJIGS_DASHBOARD_PORT=4000\n");

  connectHub("https://hub.acme.test", "secret-token", deps());

  expect(read("jigs.config.ts")).toBe(
    `export default defineFactory({\n  hub: { url: "https://hub.acme.test" },\n  workflows: {},\n});\n`,
  );
  expect(read(".env")).toBe(
    "WORKFLOW_POSTGRES_URL=postgres://x\nJIGS_HUB_TOKEN=secret-token\nJIGS_DASHBOARD_PORT=4000\n",
  );
  expect(lines).toContain("hub set to https://hub.acme.test in jigs.config.ts");
});

test("a factory without a hub section gets one, and a .env without the slot gets a line", () => {
  write("jigs.config.ts", `export default { workflows: {} };\n`);
  write(".env", "WORKFLOW_POSTGRES_URL=postgres://x");

  connectHub("https://hub.acme.test", "t", deps());

  expect(read("jigs.config.ts")).toBe(
    `export default { hub: { url: "https://hub.acme.test" }, workflows: {} };\n`,
  );
  expect(read(".env")).toBe("WORKFLOW_POSTGRES_URL=postgres://x\nJIGS_HUB_TOKEN=t\n");
});

test("a hub section added to a config goes above the first property's comment", () => {
  write(
    "jigs.config.ts",
    `export default defineFactory({\n  // where the service listens\n  service: { dashboardPort: 9090 },\n  workflows: {},\n});\n`,
  );
  write(".env", "");

  connectHub("https://hub.acme.test", "t", deps());

  expect(read("jigs.config.ts")).toBe(
    `export default defineFactory({\n  hub: { url: "https://hub.acme.test" },\n  // where the service listens\n  service: { dashboardPort: 9090 },\n  workflows: {},\n});\n`,
  );
});

test("a URL that is not one, or an empty token, changes nothing", () => {
  write(".env", "JIGS_HUB_TOKEN=\n");
  const config = read("jigs.config.ts");
  expect(() => connectHub("hub.acme.test", "t", deps())).toThrow("is not a URL");
  expect(() => connectHub("https://hub.acme.test", " ", deps())).toThrow("token is empty");
  expect(read("jigs.config.ts")).toBe(config);
  expect(read(".env")).toBe("JIGS_HUB_TOKEN=\n");
});

test("without a .env, connect asks for one first", () => {
  expect(() => connectHub("https://hub.acme.test", "t", deps())).toThrow("no .env");
});
