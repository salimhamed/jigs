import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { JigsError } from "../../errors.ts";
import { runDoctor } from "./doctor.ts";

const fetchMock = vi.fn();
let lines: string[];

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  lines = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const deps = () => ({
  out: (line: string) => lines.push(line),
  serviceUrl: "http://svc.test:8990",
  systemd: { available: () => true, linger: () => true, stopScope: () => undefined },
});

const respond = (body: unknown) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body)));

test("a green report prints one ok line per check and does not throw", async () => {
  respond({
    ok: true,
    checks: [
      { id: "core.linear-api-key", label: "Linear API key", ok: true },
      { id: "binding.api", label: "binding api", ok: true },
    ],
  });
  const report = await runDoctor(deps());
  expect(fetchMock.mock.calls[0]?.[0]).toBe("http://svc.test:8990/api/doctor");
  expect(report.ok).toBe(true);
  expect(lines).toEqual([
    "ok   systemd user service supervision",
    "ok   Linear API key",
    "ok   binding api",
  ]);
});

test("a red report prints the reason and repair for each failure and throws a JigsError", async () => {
  respond({
    ok: false,
    checks: [
      { id: "core.linear-api-key", label: "Linear API key", ok: true },
      {
        id: "binding.api",
        label: "binding api",
        ok: false,
        reason: "no binding named 'api'",
        repair: "run: jigs bind <the-api-remote-url> --binding-name api",
      },
      {
        id: "harness.codex-auth",
        label: "Codex subscription login",
        ok: false,
        reason: "no Codex login found",
        repair: "run: codex login",
      },
    ],
  });
  const failure = await runDoctor(deps()).then(
    () => null,
    (err: unknown) => err,
  );
  expect(failure).toBeInstanceOf(JigsError);
  expect((failure as JigsError).message).toBe("doctor found 2 problem(s)");
  expect(lines).toEqual([
    "ok   systemd user service supervision",
    "ok   Linear API key",
    "FAIL binding api: no binding named 'api'",
    "  → run: jigs bind <the-api-remote-url> --binding-name api",
    "FAIL Codex subscription login: no Codex login found",
    "  → run: codex login",
  ]);
});

test("an unreachable service surfaces the shared unreachable error", async () => {
  fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
  const failure = await runDoctor(deps()).then(
    () => null,
    (err: unknown) => err,
  );
  expect(failure).toBeInstanceOf(JigsError);
  expect((failure as JigsError).message).toContain("http://svc.test:8990");
});

test("a trailing slash on the service URL does not break the doctor route", async () => {
  respond({ ok: true, checks: [] });
  await runDoctor({
    out: (line: string) => lines.push(line),
    serviceUrl: "http://svc.test:8990/",
    systemd: { available: () => true, linger: () => true, stopScope: () => undefined },
  });
  expect(fetchMock.mock.calls[0]?.[0]).toBe("http://svc.test:8990/api/doctor");
});

test("a passing check that found something prints what it found", async () => {
  respond({
    ok: true,
    checks: [
      {
        id: "harness.codex-cli",
        label: "Codex CLI",
        ok: true,
        detail: "codex 0.153.4 at /usr/local/bin/codex (minimum 0.153.0)",
      },
    ],
  });
  await runDoctor(deps());
  expect(lines).toEqual([
    "ok   systemd user service supervision",
    "ok   Codex CLI: codex 0.153.4 at /usr/local/bin/codex (minimum 0.153.0)",
  ]);
});

test("doctor warns with the linger repair when linger is off", async () => {
  vi.stubEnv("USER", "salim");
  respond({ ok: true, checks: [] });

  await runDoctor({
    ...deps(),
    systemd: { available: () => true, linger: () => false, stopScope: () => undefined },
  });

  expect(lines).toContain(
    "WARN systemd linger is off; the service may die when the last login session ends",
  );
  expect(lines).toContain("  → loginctl enable-linger $USER");
});

test("doctor warns when systemd user scopes are unavailable", async () => {
  respond({ ok: true, checks: [] });

  await runDoctor({
    ...deps(),
    systemd: { available: () => false, linger: () => undefined, stopScope: () => undefined },
  });

  expect(lines[0]).toContain("unsupervised and dies on logout");
});
