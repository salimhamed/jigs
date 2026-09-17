import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { JigsError } from "../../errors.ts";
import { makeFactoryRepo, makeTmpDir, removeTmpDir } from "../../test-fixtures.ts";
import { launchRun, parseInputs, validateInputs } from "./run.ts";
import { SERVICE_ENTRY } from "./service-lifecycle.ts";

const fetchMock = vi.fn();
let lines: string[];
let tmp: string;

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  lines = [];
  tmp = makeTmpDir();
  vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

const deps = () => ({
  out: (line: string) => lines.push(line),
  serviceUrl: "http://svc.test:8990",
  sleep: async () => {},
});

const inputsSchema = z.toJSONSchema(
  z.object({
    ticket: z.union([z.uuid(), z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/)]),
    askHuman: z.boolean().default(false),
  }),
  { io: "input" },
);

const respondSchema = () =>
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ name: "deliver-feature", inputs: inputsSchema })),
  );

const respondStarted = () =>
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        runId: "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM",
        workflow: "deliver-feature",
        logs: "http://localhost:9090/run/wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM",
      }),
      { status: 201 },
    ),
  );

const respondStatus = (status: string, error?: string) =>
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ status, ...(error === undefined ? {} : { error }) })),
  );

const launchAndPoll = () => launchRun("deliver-feature", ["ticket=AGE-346"], deps());

// A factory whose build lands `offsetMs` after its sources: negative for the
// edit `jigs up` has yet to pick up.
function factoryBuilt(offsetMs: number): string {
  const root = makeFactoryRepo(tmp);
  writeFileSync(path.join(root, "jigs.config.ts"), "");
  const entry = path.join(root, SERVICE_ENTRY);
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, "");
  const built = new Date(Date.now() + offsetMs);
  utimesSync(entry, built, built);
  return root;
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (err: unknown) => err as JigsError,
  );

test("a value the workflow's schema rejects fails with the schema's own error", () => {
  const thrown = (() => {
    try {
      validateInputs(inputsSchema, { ticket: "not-a-ticket" });
    } catch (err) {
      return err as JigsError;
    }
    return null;
  })();
  expect(thrown).toBeInstanceOf(JigsError);
  expect(thrown?.message).toContain("Invalid input");
  expect(thrown?.hint).toContain("inputs schema");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a schema violation never reaches the trigger route", async () => {
  respondSchema();
  const err = await failure(launchRun("deliver-feature", ["ticket=not-a-ticket"], deps()));
  expect(err).toBeInstanceOf(JigsError);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    "http://svc.test:8990/api/workflows/deliver-feature/inputs",
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
      return err as JigsError;
    }
    return null;
  })();
  expect(thrown).toBeInstanceOf(JigsError);
  expect(thrown?.message).toBe("--input must be key=value");
  expect(thrown?.hint).toContain("--input ticket=AGE-123");
});

test("an unknown workflow fails naming the workflows the service does host", async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        error: "unknown workflow: nope",
        knownWorkflows: ["triage-bug", "deliver-feature"],
      }),
      { status: 404 },
    ),
  );
  const err = await failure(launchRun("nope", [], deps()));
  expect(err?.message).toBe("unknown workflow: nope");
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
            repair: "run: jigs bind <the-api-remote-url> --name api",
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
  const err = await failure(launchRun("deliver-feature", ["ticket=AGE-346"], deps()));
  expect(err?.message).toBe("preflight failed — no run created");
  expect(lines.join("\n")).toBe(
    [
      "binding api: no binding named 'api'",
      "  → run: jigs bind <the-api-remote-url> --name api",
      "Codex subscription login: no Codex login found",
      "  → run: codex login",
    ].join("\n"),
  );
});

test("a started run prints its id, workflow and log pointer", async () => {
  respondSchema();
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        runId: "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM",
        workflow: "deliver-feature",
        logs: "http://localhost:9090/run/wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM",
      }),
      { status: 201 },
    ),
  );
  await launchRun("deliver-feature", ["ticket=AGE-346"], deps());
  expect(lines).toEqual([
    "run wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM",
    "workflow deliver-feature",
    "logs: http://localhost:9090/run/wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM",
  ]);
  const [, trigger] = fetchMock.mock.calls;
  expect(trigger?.[0]).toBe("http://svc.test:8990/api/workflows/deliver-feature/runs");
  expect(JSON.parse(String(trigger?.[1]?.body))).toEqual({
    inputs: { ticket: "AGE-346" },
  });
});

test("a run that fails within the poll window prints its status and error and fails", async () => {
  respondSchema();
  respondStarted();
  respondStatus("failed", "Error: bad binding");

  const err = await failure(launchAndPoll());

  expect(err?.message).toBe("run wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM failed");
  expect(lines).toContain("status failed");
  expect(lines).toContain("error Error: bad binding");
});

test("a run still running after the poll window keeps the launch successful", async () => {
  respondSchema();
  respondStarted();
  respondStatus("running");
  respondStatus("running");

  await expect(launchAndPoll()).resolves.toMatchObject({
    workflow: "deliver-feature",
  });
  expect(lines).toHaveLength(3);
});

test("a run completed within the poll window keeps the launch successful", async () => {
  respondSchema();
  respondStarted();
  respondStatus("completed");

  await expect(launchAndPoll()).resolves.toMatchObject({
    workflow: "deliver-feature",
  });
  expect(lines).toHaveLength(3);
});

test("an unreachable status poll keeps the launch successful", async () => {
  respondSchema();
  respondStarted();
  fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

  await expect(launchAndPoll()).resolves.toMatchObject({
    workflow: "deliver-feature",
  });
  expect(lines).toHaveLength(3);
});

test("a misspelled --input key is refused before the launch is paid for", async () => {
  respondSchema();
  const err = await failure(
    launchRun("deliver-feature", ["ticket=AGE-346", "askhuman=true"], deps()),
  );
  expect(err).toBeInstanceOf(JigsError);
  expect(err?.message).toBe("unknown --input: askhuman");
  expect(err?.hint).toContain("askHuman");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("a workflow that accepts extra keys still takes them", () => {
  const loose = z.toJSONSchema(z.looseObject({ ticket: z.string() }), {
    io: "input",
  });
  expect(() => validateInputs(loose, { ticket: "x", extra: 1 })).not.toThrow();
});

test("a refinement only the service can see renders as a schema error", async () => {
  respondSchema();
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        error: "invalid inputs",
        issues: [
          { path: ["ticket"], message: "issue is closed" },
          { path: [], message: "askHuman requires a reviewer" },
        ],
      }),
      { status: 400 },
    ),
  );
  const err = await failure(launchRun("deliver-feature", ["ticket=AGE-346"], deps()));
  expect(err).toBeInstanceOf(JigsError);
  expect(err?.message).toBe(
    ["ticket: issue is closed", "(root): askHuman requires a reviewer"].join("\n"),
  );
  expect(err?.hint).toContain("inputs schema");
});

test("a 400 carrying no issues keeps the raw-body error", async () => {
  respondSchema();
  fetchMock.mockResolvedValueOnce(new Response("nope", { status: 400 }));
  const err = await failure(launchRun("deliver-feature", ["ticket=AGE-346"], deps()));
  expect(err?.message).toBe("launch failed: HTTP 400 nope");
});

test("an unreachable service surfaces the shared unreachable error", async () => {
  fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
  const err = await failure(launchRun("deliver-feature", [], deps()));
  expect(err?.message).toContain("http://svc.test:8990");
});

test("a run launched over sources newer than the build says so, and still launches", async () => {
  respondSchema();
  respondStarted();

  await launchRun("deliver-feature", ["ticket=AGE-346"], {
    ...deps(),
    factoryCwd: factoryBuilt(-60_000),
  });

  expect(lines[0]).toContain("jigs.config.ts newer than the built service");
  expect(lines[1]).toContain("jigs up");
  expect(lines).toContain("run wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM");
});

test("a build newer than the sources launches without a word about it", async () => {
  respondSchema();
  respondStarted();

  await launchRun("deliver-feature", ["ticket=AGE-346"], {
    ...deps(),
    factoryCwd: factoryBuilt(60_000),
  });

  expect(lines[0]).toBe("run wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM");
});

test("a run aimed at another factory's service is silent about this one's sources", async () => {
  respondSchema();
  respondStarted();
  factoryBuilt(-60_000);

  await launchRun("deliver-feature", ["ticket=AGE-346"], deps());

  expect(lines[0]).toBe("run wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM");
});

test("a workflow the bundle does not have yet hears about the stale build first", async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ knownWorkflows: ["ship"] }), { status: 404 }),
  );

  const err = await failure(
    launchRun("triage", [], { ...deps(), factoryCwd: factoryBuilt(-60_000) }),
  );

  expect(lines[0]).toContain("jigs.config.ts newer than the built service");
  expect(err?.message).toContain("unknown workflow: triage");
});

test("a freshness check that cannot read the factory costs no run", async () => {
  respondSchema();
  respondStarted();

  await launchRun("deliver-feature", ["ticket=AGE-346"], {
    ...deps(),
    factoryCwd: tmp,
  });

  expect(lines[0]).toBe("run wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM");
});
