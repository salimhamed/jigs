import { z } from "zod";
import { type CheckReport, formatFailures } from "../checks/catalog.ts";
import { CliError } from "../errors.ts";
import { type ServiceDeps, serviceFetch } from "./service.ts";

export interface LaunchResult {
  runId: string;
  pipeline: string;
  resumeToken?: string;
  logs?: string;
}

// Flat on purpose: one coercion rule to hold in your head. A nested value
// goes in as inline JSON — `--input pr={"owner":"acme","repo":"api"}`.
export function parseInputs(pairs: string[]): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const pair of pairs) {
    const split = pair.indexOf("=");
    if (split <= 0) {
      throw new CliError(
        "--input must be key=value",
        "example: --input ticket=AGE-123",
      );
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

export function validateInputs(
  schema: z.core.JSONSchema.BaseSchema,
  inputs: Record<string, unknown>,
): void {
  const result = z.fromJSONSchema(schema).safeParse(inputs);
  if (!result.success) {
    throw new CliError(
      z.prettifyError(result.error),
      "check --input against the pipeline's inputs schema",
    );
  }
}

export async function launchRun(
  pipeline: string,
  pairs: string[],
  deps: ServiceDeps,
): Promise<LaunchResult> {
  const inputs = parseInputs(pairs);

  // Client-side first: a schema violation must cost no run. The registry owns
  // the schema, so the CLI fetches it rather than keeping a second copy.
  const schemaRes = await serviceFetch(
    deps.serviceUrl,
    `/api/pipelines/${encodeURIComponent(pipeline)}/inputs`,
  );
  if (schemaRes.status === 404) {
    const body = (await schemaRes.json().catch(() => ({}))) as {
      knownPipelines?: string[];
    };
    throw new CliError(
      `unknown pipeline: ${pipeline}`,
      `known pipelines: ${(body.knownPipelines ?? []).join(", ")}`,
    );
  }
  if (!schemaRes.ok) {
    throw new CliError(
      `could not read the inputs schema: HTTP ${schemaRes.status} ${await schemaRes.text()}`,
    );
  }
  const { inputs: schema } = (await schemaRes.json()) as {
    inputs: z.core.JSONSchema.BaseSchema;
  };
  validateInputs(schema, inputs);

  const res = await serviceFetch(
    deps.serviceUrl,
    `/api/pipelines/${encodeURIComponent(pipeline)}/runs`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputs }),
    },
  );
  if (res.status === 424) {
    const body = (await res.json()) as { failures: CheckReport["checks"] };
    deps.out(formatFailures({ ok: false, checks: body.failures }));
    throw new CliError("preflight failed — no run created");
  }
  if (!res.ok) {
    throw new CliError(`launch failed: HTTP ${res.status} ${await res.text()}`);
  }
  const result = (await res.json()) as LaunchResult;
  deps.out(`run ${result.runId}`);
  deps.out(`pipeline ${result.pipeline}`);
  if (result.resumeToken !== undefined) {
    deps.out(`resume token ${result.resumeToken}`);
  }
  deps.out(`logs: ${result.logs ?? `npx workflow web ${result.runId}`}`);
  return result;
}
