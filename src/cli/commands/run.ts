import { z } from "zod";
import { type CheckReport, failedChecks } from "../../checks/catalog.ts";
import { JigsError } from "../../errors.ts";
import { columns, hint, indent, runHeading } from "../output.ts";
import { checkLines } from "./doctor.ts";
import { type ServiceDeps, serviceFetch } from "./service-client.ts";
import { serviceBehindSources } from "./service-lifecycle.ts";

export interface LaunchDeps extends ServiceDeps {
  // Set only when the run goes to the local factory's own service, so the
  // freshness warning speaks about the sources that service was built from.
  // An explicit --service-url is some other factory's, and this factory's sources
  // say nothing about it.
  factoryCwd?: string;
}

export interface LaunchResult {
  runId: string;
  workflow: string;
  dashboard: string;
}

export type InputPair = [key: string, raw: string];

export function splitInputs(pairs: string[]): InputPair[] {
  return pairs.map((pair) => {
    const split = pair.indexOf("=");
    if (split <= 0) {
      throw new JigsError("--input must be key=value", "for example: --input ticket=AGE-123");
    }
    return [pair.slice(0, split), pair.slice(split + 1)];
  });
}

// A nested value goes in as inline JSON — `--input pr={"owner":"acme","repo":"api"}`.
export function coerceInputs(
  pairs: InputPair[],
  schema: z.core.JSONSchema.BaseSchema,
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const [key, raw] of pairs) {
    const types = fieldTypes(schema.properties?.[key]);
    if (types?.has("string") && [...types].every((t) => t === "string" || t === "null")) {
      inputs[key] = raw === "null" && types.has("null") ? null : asString(raw);
    } else {
      inputs[key] = coerce(raw);
    }
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

// A string field skips the coercion, or a numeric-looking ID would turn into a
// number. It still takes a JSON-quoted string, the form a trigger's repair
// command prints.
function asString(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const parsed = coerce(raw);
  return typeof parsed === "string" ? parsed : raw;
}

// Every JSON type a field accepts, or undefined when the schema does not say.
function fieldTypes(field: z.core.JSONSchema._JSONSchema | undefined): Set<string> | undefined {
  if (typeof field !== "object") return undefined;
  const branches = field.anyOf ?? field.oneOf;
  if (branches !== undefined) {
    const types = new Set<string>();
    for (const branch of branches) {
      const inner = fieldTypes(branch);
      if (inner === undefined) return undefined;
      for (const t of inner) types.add(t);
    }
    return types.size > 0 ? types : undefined;
  }
  if (field.type === undefined) return undefined;
  return new Set(Array.isArray(field.type) ? field.type : [field.type]);
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
  const rawInputs = splitInputs(pairs);
  // Ahead of the schema fetch: a workflow the bundle does not have and an
  // input its schema does not have are the loudest symptoms of a stale build,
  // and both are fatal below.
  const out = afterSection(reportStaleBundle(deps), deps.out);

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
  const inputs = coerceInputs(rawInputs, schema);
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
    const report = { ok: false, checks: body.failures };
    for (const line of failedChecks(report).flatMap(checkLines)) out(line);
    throw new JigsError("preflight failed, so no run was created");
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
  for (const line of [
    runHeading(result.runId, "started"),
    ...indent([
      ...columns([
        ["workflow", result.workflow],
        ["dashboard", result.dashboard],
      ]),
      ...hint("inspect it:", `pnpm exec jigs status ${result.runId}`),
    ]),
  ]) {
    out(line);
  }
  return result;
}

// A warning, not a refusal: the previous bundle is still a workflow, and the
// operator may well mean to run it.
function reportStaleBundle(deps: LaunchDeps): boolean {
  if (deps.factoryCwd === undefined) return false;
  let behind: string | undefined;
  try {
    behind = serviceBehindSources({ cwd: deps.factoryCwd });
  } catch {
    // A file that moved while the sources were being read is no reason to
    // lose the launch.
    return false;
  }
  if (behind === undefined) return false;
  for (const line of [
    `warning: ${behind}, so this run uses the previous bundle`,
    ...hint("to run the current sources, first run:", "pnpm exec jigs up"),
  ]) {
    deps.out(line);
  }
  return true;
}

// A printed warning is a section of its own, so whatever follows it starts after a blank line.
function afterSection(printed: boolean, out: (line: string) => void): (line: string) => void {
  let pending = printed;
  return (line) => {
    if (pending) out("");
    pending = false;
    out(line);
  };
}
