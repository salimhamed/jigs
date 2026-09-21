import { lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { models } from "../../../blocks/agents/harness-config.ts";
import { ensureManagedPiHome } from "./pi-home.ts";
import { makeTmpDir, removeTmpDir } from "./test-fixtures.ts";

let tmp: string;

beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => {
  removeTmpDir(tmp);
});

test("managed pi home writes isolated settings and a local model catalog without wiping sessions", () => {
  const source = models.openaiCompatible({
    name: "north-desktop",
    baseUrl: "http://localhost:1234/v1",
    model: "local-model",
    apiKeyEnv: "LOCAL_MODEL_KEY",
    compat: { supportsDeveloperRole: true },
  });
  const home = ensureManagedPiHome("run-1", source, { baseDir: path.join(tmp, "pi-homes") });

  expect(JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8"))).toEqual({
    packages: [],
  });
  expect(JSON.parse(readFileSync(path.join(home, "models.json"), "utf8"))).toEqual({
    providers: {
      "north-desktop": {
        baseUrl: "http://localhost:1234/v1",
        api: "openai-completions",
        apiKey: "$LOCAL_MODEL_KEY",
        compat: { supportsDeveloperRole: true, supportsReasoningEffort: false },
        models: [
          {
            id: "local-model",
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  });

  const session = path.join(home, "sessions", "kept.jsonl");
  mkdirSync(path.dirname(session), { recursive: true });
  writeFileSync(session, "kept");
  writeFileSync(path.join(home, "settings.json"), '{"packages":["operator-package"]}');
  ensureManagedPiHome("run-1", source, { baseDir: path.join(tmp, "pi-homes") });
  expect(readFileSync(session, "utf8")).toBe("kept");
  expect(JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8"))).toEqual({
    packages: [],
  });
});

test("Codex-backed pi homes symlink the real login while other sources never touch it", () => {
  const realAuthPath = path.join(tmp, "operator-pi", "auth.json");
  mkdirSync(path.dirname(realAuthPath), { recursive: true });
  writeFileSync(realAuthPath, '{"openai-codex":{"type":"oauth"}}');
  const options = { baseDir: path.join(tmp, "pi-homes"), realAuthPath };

  const openrouterHome = ensureManagedPiHome("router-run", models.openrouter("model"), options);
  expect(() => lstatSync(path.join(openrouterHome, "auth.json"))).toThrow();
  expect(() => lstatSync(path.join(openrouterHome, "models.json"))).toThrow();

  const codexHome = ensureManagedPiHome("codex-run", models.openaiCodex("gpt-5.5"), options);
  const authPath = path.join(codexHome, "auth.json");
  expect(lstatSync(authPath).isSymbolicLink()).toBe(true);
  expect(readlinkSync(authPath)).toBe(realAuthPath);
  expect(() => lstatSync(path.join(codexHome, "models.json"))).toThrow();

  ensureManagedPiHome("codex-run", models.openrouter("model"), options);
  expect(() => lstatSync(authPath)).toThrow();
});
