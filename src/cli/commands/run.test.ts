import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { JigsError } from "../../errors.ts";
import { makeFactoryRepo, makeTmpDir, removeTmpDir, stubService } from "../../test-fixtures.ts";
import { layoutProblems } from "../output-layout.ts";
import { coerceInputs, launchRun, splitInputs, validateInputs } from "./run.ts";
import { SERVICE_ENTRY } from "./service-lifecycle.ts";

const fetchMock = vi.fn();
let lines: string[];
let tmp: string;

beforeEach(() => {
  stubService(fetchMock);
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
        dashboard: "http://localhost:9090/run/wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM",
      }),
      { status: 201 },
    ),
  );

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
    coerceInputs(
      splitInputs([
        "stepSeconds=3",
        "askHuman=true",
        "ticket=AGE-123",
        "issueId=6b1c1d2e-0000-4000-8000-000000000000",
        'pr={"owner":"acme","repo":"api","number":41}',
      ]),
      {},
    ),
  ).toEqual({
    stepSeconds: 3,
    askHuman: true,
    ticket: "AGE-123",
    issueId: "6b1c1d2e-0000-4000-8000-000000000000",
    pr: { owner: "acme", repo: "api", number: 41 },
  });
});

test("a value containing = keeps everything after the first one", () => {
  expect(coerceInputs(splitInputs(["note=a=b"]), {})).toEqual({ note: "a=b" });
});

test("a string field takes the raw text or a JSON-quoted string, and other fields are still parsed", () => {
  const schema = z.toJSONSchema(
    z.object({ ts: z.string(), thread: z.string().optional(), limit: z.number() }),
    { io: "input" },
  );
  expect(
    coerceInputs(splitInputs(["ts=1787145691.947349", 'thread="42"', "limit=3"]), schema),
  ).toEqual({
    ts: "1787145691.947349",
    thread: "42",
    limit: 3,
  });
});

test("an --input without = fails with an example", () => {
  const thrown = (() => {
    try {
      splitInputs(["ticket"]);
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
            repair: "bind it: `pnpm exec jigs bind <the-api-remote-url> --binding-name api`",
          },
          {
            id: "harness.codex-auth",
            label: "Codex subscription login",
            ok: false,
            reason: "no Codex login found",
            repair: "run: `codex login`",
          },
        ],
      }),
      { status: 424 },
    ),
  );
  const err = await failure(launchRun("deliver-feature", ["ticket=AGE-346"], deps()));
  expect(err?.message).toBe("preflight failed, so no run was created");
  expect(lines).toEqual([
    "FAIL binding api: no binding named 'api'",
    "  bind it:",
    "    pnpm exec jigs bind <the-api-remote-url> --binding-name api",
    "FAIL Codex subscription login: no Codex login found",
    "  run:",
    "    codex login",
  ]);
});

test("a started run prints its id, workflow and log pointer", async () => {
  respondSchema();
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        runId: "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM",
        workflow: "deliver-feature",
        dashboard: "http://localhost:9090/run/wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM",
      }),
      { status: 201 },
    ),
  );
  await launchRun("deliver-feature", ["ticket=AGE-346"], deps());
  expect(lines).toEqual([
    "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM  started",
    "  workflow   deliver-feature",
    "  dashboard  http://localhost:9090/run/wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM",
    "  inspect it:",
    "    pnpm exec jigs status wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM",
  ]);
  const [, trigger] = fetchMock.mock.calls;
  expect(trigger?.[0]).toBe("http://svc.test:8990/api/workflows/deliver-feature/runs");
  expect(JSON.parse(String(trigger?.[1]?.body))).toEqual({
    inputs: { ticket: "AGE-346" },
  });
});

test("a string field keeps a value that looks like a number, such as a Slack ts", async () => {
  const slackSchema = z.toJSONSchema(z.object({ channel: z.string(), ts: z.string() }), {
    io: "input",
  });
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ name: "whats-new", inputs: slackSchema })),
  );
  respondStarted();
  await launchRun("whats-new", ["channel=C040SAKCZHP", "ts=1787145691.947349000001"], deps());
  const [, trigger] = fetchMock.mock.calls;
  expect(JSON.parse(String(trigger?.[1]?.body))).toEqual({
    inputs: { channel: "C040SAKCZHP", ts: "1787145691.947349000001" },
  });
});

test("a nullable string field keeps a Slack ts as text and still takes null", async () => {
  const schema = z.toJSONSchema(
    z.object({
      ts: z.string().nullable(),
      thread: z.string().nullish(),
      id: z.string().nullable(),
    }),
    { io: "input" },
  );
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ name: "whats-new", inputs: schema })),
  );
  respondStarted();
  await launchRun("whats-new", ["ts=1787145691.947349000001", "thread=null", 'id="null"'], deps());
  const [, trigger] = fetchMock.mock.calls;
  expect(JSON.parse(String(trigger?.[1]?.body))).toEqual({
    inputs: { ts: "1787145691.947349000001", thread: null, id: "null" },
  });
});

test("a field that takes a string or a number still reads a number as JSON", async () => {
  const schema = z.toJSONSchema(z.object({ ref: z.union([z.string(), z.number()]) }), {
    io: "input",
  });
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ name: "w", inputs: schema })));
  respondStarted();
  await launchRun("w", ["ref=42"], deps());
  const [, trigger] = fetchMock.mock.calls;
  expect(JSON.parse(String(trigger?.[1]?.body))).toEqual({ inputs: { ref: 42 } });
});

test("a malformed --input fails before any request to the service", async () => {
  const err = await failure(launchRun("deliver-feature", ["ticket"], deps()));
  expect(err?.message).toBe("--input must be key=value");
  expect(fetchMock).not.toHaveBeenCalled();
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
  expect(lines[2]).toContain("pnpm exec jigs up");
  expect(lines).toContain("wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM  started");
});

test("a build newer than the sources launches without a word about it", async () => {
  respondSchema();
  respondStarted();

  await launchRun("deliver-feature", ["ticket=AGE-346"], {
    ...deps(),
    factoryCwd: factoryBuilt(60_000),
  });

  expect(lines[0]).toBe("wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM  started");
});

test("a run aimed at another factory's service is silent about this one's sources", async () => {
  respondSchema();
  respondStarted();
  factoryBuilt(-60_000);

  await launchRun("deliver-feature", ["ticket=AGE-346"], deps());

  expect(lines[0]).toBe("wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM  started");
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

  expect(lines[0]).toBe("wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM  started");
});

// Every test's output, passing or failing, keeps to the shared layout.
afterEach(() => {
  expect(layoutProblems(lines)).toEqual([]);
});
