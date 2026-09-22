import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { harnesses, models } from "../../../blocks/agents/harness-config.ts";
import { writePiSubmitResultExtension } from "./pi-extension.ts";
import {
  managedPiHomePath,
  piSessionFile,
  prepareManagedPiHome,
  removeManagedPiHome,
} from "./pi-home.ts";
import { planPiModel } from "./pi-model.ts";
import { makeTmpDir, removeTmpDir } from "./test-fixtures.ts";

let tmp: string;

beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => {
  removeTmpDir(tmp);
});

test("parallel Pi invocations have private configuration and shared durable sessions", () => {
  const options = { baseDir: path.join(tmp, "pi-homes") };
  const local = prepareManagedPiHome(
    "run-1",
    planPiModel(
      harnesses.pi(
        models.openaiCompatible({
          name: "north-desktop",
          baseUrl: "http://localhost:1234/v1",
          model: "local-model",
          apiKeyEnv: "LOCAL_MODEL_KEY",
        }),
        { compat: { supportsDeveloperRole: true } },
      ),
    ),
    options,
  );
  const router = prepareManagedPiHome(
    "run-1",
    planPiModel(harnesses.pi(models.openrouter("openai/gpt-oss"))),
    options,
  );

  expect(local.home).not.toBe(router.home);
  expect(local.sessionDir).toBe(router.sessionDir);
  expect(JSON.parse(readFileSync(path.join(local.home, "models.json"), "utf8"))).toMatchObject({
    providers: { "north-desktop": { baseUrl: "http://localhost:1234/v1" } },
  });
  expect(() => lstatSync(path.join(router.home, "models.json"))).toThrow();
  expect(JSON.parse(readFileSync(path.join(local.home, "settings.json"), "utf8"))).toEqual({
    packages: [],
  });
  const localExtension = writePiSubmitResultExtension(local.home, { type: "string" });
  const routerExtension = writePiSubmitResultExtension(router.home, { type: "boolean" });
  expect(localExtension).not.toBe(routerExtension);
  expect(localExtension.startsWith(local.home)).toBe(true);
  expect(routerExtension.startsWith(router.home)).toBe(true);

  const session = path.join(local.sessionDir, "2026_existing.jsonl");
  writeFileSync(session, "durable");
  local.cleanup();
  expect(existsSync(local.home)).toBe(false);
  expect(existsSync(router.home)).toBe(true);
  expect(readFileSync(session, "utf8")).toBe("durable");

  router.cleanup();
  const afterRestart = prepareManagedPiHome(
    "run-1",
    planPiModel(harnesses.pi(models.openrouter("openai/gpt-oss"))),
    options,
  );
  expect(afterRestart.sessionDir).toBe(local.sessionDir);
  expect(readFileSync(session, "utf8")).toBe("durable");
  afterRestart.cleanup();
});

test("Codex-backed Pi configuration links the real login only for that invocation", () => {
  const realAuthPath = path.join(tmp, "operator-pi", "auth.json");
  mkdirSync(path.dirname(realAuthPath), { recursive: true });
  writeFileSync(realAuthPath, '{"openai-codex":{"type":"oauth"}}');
  const prepared = prepareManagedPiHome("codex-run", planPiModel(harnesses.pi(models.openaiCodex("gpt-5.5"))), {
    baseDir: path.join(tmp, "pi-homes"),
    realAuthPath,
  });

  const authPath = path.join(prepared.home, "auth.json");
  expect(lstatSync(authPath).isSymbolicLink()).toBe(true);
  expect(readlinkSync(authPath)).toBe(realAuthPath);
  prepared.cleanup();
  expect(existsSync(prepared.home)).toBe(false);
  expect(existsSync(realAuthPath)).toBe(true);
});

test("a missing real login fails before creating durable Pi state", () => {
  const options = {
    baseDir: path.join(tmp, "pi-homes"),
    realAuthPath: path.join(tmp, "missing.json"),
  };

  expect(() =>
    prepareManagedPiHome("run-1", planPiModel(models.openaiCodex("gpt-5.5")), options),
  ).toThrow(/no Pi openai-codex login found.*pi \/login/);
  expect(existsSync(managedPiHomePath("run-1", options))).toBe(false);
});

test("Pi resumes only an exact durable session file", () => {
  const prepared = prepareManagedPiHome("run-1", planPiModel(harnesses.pi(models.openrouter("openai/gpt-oss"))), {
    baseDir: path.join(tmp, "pi-homes"),
  });
  writeFileSync(path.join(prepared.sessionDir, "2026_exact.jsonl"), "{}");
  writeFileSync(path.join(prepared.sessionDir, "2026_exact-extra.jsonl"), "{}");

  expect(piSessionFile(prepared.sessionDir, "exact")).toBe(
    path.join(prepared.sessionDir, "2026_exact.jsonl"),
  );
  expect(piSessionFile(prepared.sessionDir, "missing")).toBeUndefined();
  prepared.cleanup();
});

test("removeManagedPiHome deletes durable sessions with the run", () => {
  const options = { baseDir: path.join(tmp, "pi-homes") };
  const prepared = prepareManagedPiHome(
    "run-1",
    planPiModel(harnesses.pi(models.openrouter("openai/gpt-oss"))),
    options,
  );
  writeFileSync(path.join(prepared.sessionDir, "session.jsonl"), "durable until teardown");
  prepared.cleanup();

  removeManagedPiHome("run-1", options);

  expect(existsSync(managedPiHomePath("run-1", options))).toBe(false);
});
