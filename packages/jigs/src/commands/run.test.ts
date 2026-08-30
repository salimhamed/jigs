import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { CliError } from "../errors.ts";
import { launchRun, parseInputs, validateInputs } from "./run.ts";

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
});

const inputsSchema = z.toJSONSchema(
  z.object({
    issueId: z.uuid(),
    askHuman: z.boolean().default(false),
  }),
  { io: "input" },
);

const respondSchema = () =>
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({ name: "deliver-feature", inputs: inputsSchema }),
    ),
  );

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (err: unknown) => err as CliError,
  );

test("a value the pipeline's schema rejects fails with the schema's own error", () => {
  const thrown = (() => {
    try {
      validateInputs(inputsSchema, { issueId: "AGE-123" });
    } catch (err) {
      return err as CliError;
    }
    return null;
  })();
  expect(thrown).toBeInstanceOf(CliError);
  expect(thrown?.message).toContain("Invalid UUID");
  expect(thrown?.hint).toContain("inputs schema");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a schema violation never reaches the trigger route", async () => {
  respondSchema();
  const err = await failure(
    launchRun("deliver-feature", ["issueId=AGE-123"], deps()),
  );
  expect(err).toBeInstanceOf(CliError);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    "http://svc.test:8990/api/pipelines/deliver-feature/inputs",
  );
});

test("input values are coerced by JSON, with the raw string as the fallback", () => {
  expect(
    parseInputs([
      "stepSeconds=3",
      "askHuman=true",
      "ticket=AGE-123",
      "issueId=6b1c1d2e-0000-4000-8000-000000000000",
      'pr={"owner":"acme","repo":"api","number":41}',
    ]),
  ).toEqual({
    stepSeconds: 3,
    askHuman: true,
    ticket: "AGE-123",
    issueId: "6b1c1d2e-0000-4000-8000-000000000000",
    pr: { owner: "acme", repo: "api", number: 41 },
  });
});

test("a value containing = keeps everything after the first one", () => {
  expect(parseInputs(["note=a=b"])).toEqual({ note: "a=b" });
});

test("an --input without = fails with an example", () => {
  const thrown = (() => {
    try {
      parseInputs(["ticket"]);
    } catch (err) {
      return err as CliError;
    }
    return null;
  })();
  expect(thrown).toBeInstanceOf(CliError);
  expect(thrown?.message).toBe("--input must be key=value");
  expect(thrown?.hint).toContain("--input ticket=AGE-123");
});

test("an unknown pipeline fails naming the pipelines the service does host", async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        error: "unknown pipeline: nope",
        knownPipelines: ["triage-bug", "deliver-feature"],
      }),
      { status: 404 },
    ),
  );
  const err = await failure(launchRun("nope", [], deps()));
  expect(err?.message).toBe("unknown pipeline: nope");
  expect(err?.hint).toContain("triage-bug, deliver-feature");
});

test("a refused launch prints every preflight failure with its repair", async () => {
  respondSchema();
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        error: "preflight failed",
        failures: [
          {
            id: "binding.api",
            label: "binding api",
            ok: false,
            reason: "no binding named 'api'",
            repair: "run: jigs bind <path> --name api",
          },
          {
            id: "harness.codex-auth",
            label: "Codex subscription login",
            ok: false,
            reason: "no Codex login found",
            repair: "run: codex login",
          },
        ],
      }),
      { status: 424 },
    ),
  );
  const err = await failure(
    launchRun(
      "deliver-feature",
      ["issueId=6b1c1d2e-0000-4000-8000-000000000000"],
      deps(),
    ),
  );
  expect(err?.message).toBe("preflight failed — no run created");
  expect(lines.join("\n")).toBe(
    [
      "binding api: no binding named 'api'",
      "  → run: jigs bind <path> --name api",
      "Codex subscription login: no Codex login found",
      "  → run: codex login",
    ].join("\n"),
  );
});

test("a started run prints its id, pipeline, resume token and log pointer", async () => {
  respondSchema();
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        runId: "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM",
        pipeline: "deliver-feature",
        resumeToken: "demo:trigger-1",
        logs: "npx workflow web --backend @workflow/world-postgres wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM",
      }),
      { status: 201 },
    ),
  );
  await launchRun(
    "deliver-feature",
    ["issueId=6b1c1d2e-0000-4000-8000-000000000000"],
    deps(),
  );
  expect(lines).toEqual([
    "run wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM",
    "pipeline deliver-feature",
    "resume token demo:trigger-1",
    "logs: npx workflow web --backend @workflow/world-postgres wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM",
  ]);
  const [, trigger] = fetchMock.mock.calls;
  expect(trigger?.[0]).toBe(
    "http://svc.test:8990/api/pipelines/deliver-feature/runs",
  );
  expect(JSON.parse(String(trigger?.[1]?.body))).toEqual({
    inputs: { issueId: "6b1c1d2e-0000-4000-8000-000000000000" },
  });
});

test("a misspelled --input key is refused before the launch is paid for", async () => {
  respondSchema();
  const err = await failure(
    launchRun(
      "deliver-feature",
      ["issueId=6b1c1d2e-0000-4000-8000-000000000000", "askhuman=true"],
      deps(),
    ),
  );
  expect(err).toBeInstanceOf(CliError);
  expect(err?.message).toBe("unknown --input: askhuman");
  expect(err?.hint).toContain("askHuman");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("a pipeline that accepts extra keys still takes them", () => {
  const loose = z.toJSONSchema(z.looseObject({ issueId: z.string() }), {
    io: "input",
  });
  expect(() => validateInputs(loose, { issueId: "x", extra: 1 })).not.toThrow();
});

test("a refinement only the service can see renders as a schema error", async () => {
  respondSchema();
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        error: "invalid inputs",
        issues: [
          { path: ["issueId"], message: "issue is closed" },
          { path: [], message: "askHuman requires a reviewer" },
        ],
      }),
      { status: 400 },
    ),
  );
  const err = await failure(
    launchRun(
      "deliver-feature",
      ["issueId=6b1c1d2e-0000-4000-8000-000000000000"],
      deps(),
    ),
  );
  expect(err).toBeInstanceOf(CliError);
  expect(err?.message).toBe(
    ["issueId: issue is closed", "(root): askHuman requires a reviewer"].join(
      "\n",
    ),
  );
  expect(err?.hint).toContain("inputs schema");
});

test("a 400 carrying no issues keeps the raw-body error", async () => {
  respondSchema();
  fetchMock.mockResolvedValueOnce(new Response("nope", { status: 400 }));
  const err = await failure(
    launchRun(
      "deliver-feature",
      ["issueId=6b1c1d2e-0000-4000-8000-000000000000"],
      deps(),
    ),
  );
  expect(err?.message).toBe("launch failed: HTTP 400 nope");
});

test("an unreachable service hints at --service / JIGS_SERVICE_URL", async () => {
  fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
  const err = await failure(launchRun("deliver-feature", [], deps()));
  expect(err?.message).toContain("http://svc.test:8990");
  expect(err?.hint).toContain("JIGS_SERVICE_URL");
});
