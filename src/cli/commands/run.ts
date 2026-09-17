import { z } from "zod";
import { type CheckReport, formatFailures } from "../../checks/catalog.ts";
import { JigsError } from "../../errors.ts";
import { TERMINAL_RUN_STATUSES } from "../../run-status.ts";
import { type ServiceDeps, serviceFetch } from "./service-client.ts";
import { serviceBehindSources } from "./service-lifecycle.ts";

export interface LaunchDeps extends ServiceDeps {
  // Set only when the run goes to the local factory's own service, so the
  // freshness warning speaks about the sources that service was built from.
  // An explicit --service is some other factory's, and this factory's sources
  // say nothing about it.
  factoryCwd?: string;
  /** Tests replace the delay; the command uses the fixed short poll window. */
  sleep?: (ms: number) => Promise<void>;
}

export interface LaunchResult {
  runId: string;
  workflow: string;
  logs: string;
}

// Flat on purpose: one coercion rule to hold in your head. A nested value
// goes in as inline JSON — `--input pr={"owner":"acme","repo":"api"}`.
export function parseInputs(pairs: string[]): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const pair of pairs) {
    const split = pair.indexOf("=");
    if (split <= 0) {
      throw new JigsError("--input must be key=value", "example: --input ticket=AGE-123");
    }
    const key = pair.slice(0, split);
    const raw = pair.slice(split + 1);
    inputs[key] = coerce(raw);
  }
  return inputs;
}

// Shell arguments are strings, but the schemas are not: a number field must
// arrive as a number. JSON is the coercion, with the raw string as fallback,
// so `AGE-123` and a bare UUID stay strings.
function coerce(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const SCHEMA_HINT = "check --input against the workflow's inputs schema";

export function validateInputs(
  schema: z.core.JSONSchema.BaseSchema,
  inputs: Record<string, unknown>,
): void {
  const result = z.fromJSONSchema(schema).safeParse(inputs);
  if (!result.success) {
    throw new JigsError(z.prettifyError(result.error), SCHEMA_HINT);
  }
  rejectUnknownKeys(schema, inputs);
}

// A plain z.object emits no `additionalProperties`, so the round trip accepts
// a misspelled key and the service's own z.object then strips it: the launch
// spends agent turns running with the default the user meant to override. A
// z.looseObject emits `{}` and does genuinely accept extra keys.
function rejectUnknownKeys(
  schema: z.core.JSONSchema.BaseSchema,
  inputs: Record<string, unknown>,
): void {
  const { properties, additionalProperties } = schema;
  if (typeof properties !== "object" || properties === null) return;
  if (additionalProperties !== undefined && additionalProperties !== false) {
    return;
  }
  const known = Object.keys(properties);
  const unknown = Object.keys(inputs).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    throw new JigsError(
      `unknown --input: ${unknown.join(", ")}`,
      `this workflow accepts: ${known.join(", ")}`,
    );
  }
}

interface SchemaIssue {
  path: Array<string | number>;
  message: string;
}

// z.toJSONSchema silently drops .refine()/.superRefine(), so a violation of
// one clears validateInputs and comes back as the trigger's 400. Rendering it
// as a schema error makes a server-side rejection read like a client-side one.
function schemaIssues(raw: string): SchemaIssue[] | null {
  try {
    const body = JSON.parse(raw) as { issues?: unknown };
    return Array.isArray(body.issues) ? (body.issues as SchemaIssue[]) : null;
  } catch {
    return null;
  }
}

export async function launchRun(
  workflow: string,
  pairs: string[],
  deps: LaunchDeps,
): Promise<LaunchResult> {
  const inputs = parseInputs(pairs);
  // Ahead of the schema fetch: a workflow the bundle does not have and an
  // input its schema does not have are the loudest symptoms of a stale build,
  // and both are fatal below.
  reportStaleBundle(deps);

  // Client-side first: a schema violation must cost no run. The factory owns
  // the schema, so the CLI fetches it rather than keeping a second copy.
  const schemaRes = await serviceFetch(
    deps.serviceUrl,
    `/api/workflows/${encodeURIComponent(workflow)}/inputs`,
  );
  if (schemaRes.status === 404) {
    const body = (await schemaRes.json().catch(() => ({}))) as {
      knownWorkflows?: string[];
    };
    throw new JigsError(
      `unknown workflow: ${workflow}`,
      `known workflows: ${(body.knownWorkflows ?? []).join(", ")}`,
    );
  }
  if (!schemaRes.ok) {
    throw new JigsError(
      `could not read the inputs schema: HTTP ${schemaRes.status} ${await schemaRes.text()}`,
    );
  }
  const { inputs: schema } = (await schemaRes.json()) as {
    inputs: z.core.JSONSchema.BaseSchema;
  };
  validateInputs(schema, inputs);

  const res = await serviceFetch(
    deps.serviceUrl,
    `/api/workflows/${encodeURIComponent(workflow)}/runs`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputs }),
    },
  );
  if (res.status === 424) {
    const body = (await res.json()) as { failures: CheckReport["checks"] };
    deps.out(formatFailures({ ok: false, checks: body.failures }));
    throw new JigsError("preflight failed — no run created");
  }
  if (!res.ok) {
    const raw = await res.text();
    const issues = schemaIssues(raw);
    if (issues !== null) {
      throw new JigsError(
        issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
        SCHEMA_HINT,
      );
    }
    throw new JigsError(`launch failed: HTTP ${res.status} ${raw}`);
  }
  const result = (await res.json()) as LaunchResult;
  deps.out(`run ${result.runId}`);
  deps.out(`workflow ${result.workflow}`);
  deps.out(`logs: ${result.logs}`);
  await reportEarlyFailure(result.runId, deps);
  return result;
}

interface RunStatus {
  status: string;
  error?: string;
}

const POLL_INTERVAL_MS = 1_250;
const POLL_WINDOW_MS = 3_000;

async function reportEarlyFailure(runId: string, deps: LaunchDeps): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const deadline = Date.now() + POLL_WINDOW_MS;

  for (let poll = 0; poll < 2; poll++) {
    await sleep(POLL_INTERVAL_MS);
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;

    let run: RunStatus;
    try {
      const res = await serviceFetch(deps.serviceUrl, `/api/runs/${encodeURIComponent(runId)}`, {
        signal: AbortSignal.timeout(remaining),
      });
      if (!res.ok) return;
      run = (await res.json()) as RunStatus;
    } catch {
      // This is a best-effort glimpse, not another condition of launching.
      return;
    }

    if (!TERMINAL_RUN_STATUSES.has(run.status)) continue;
    if (run.status === "completed") return;
    deps.out(`status ${run.status}`);
    if (run.error !== undefined) deps.out(`error ${run.error}`);
    throw new JigsError(`run ${runId} ${run.status}`);
  }
}

// A warning, not a refusal: the previous bundle is still a workflow, and the
// operator may well mean to run it.
function reportStaleBundle(deps: LaunchDeps): void {
  if (deps.factoryCwd === undefined) return;
  let behind: string | undefined;
  try {
    behind = serviceBehindSources({ cwd: deps.factoryCwd });
  } catch {
    // A file that moved while the sources were being read is no reason to
    // lose the launch.
    return;
  }
  if (behind === undefined) return;
  deps.out(`warning: ${behind} — this run executes the previous bundle`);
  deps.out("bring the service up to the sources first: jigs up");
}
