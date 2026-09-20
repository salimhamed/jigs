import type { z } from "zod";
import { JigsError } from "../../errors.ts";
import { formatTable } from "../table.ts";
import { type ServiceDeps, serviceFetch } from "./service-client.ts";

export interface WorkflowSummary {
  name: string;
  inputs: z.core.JSONSchema.BaseSchema;
}

export async function listWorkflows(deps: ServiceDeps): Promise<WorkflowSummary[]> {
  const res = await serviceFetch(deps.serviceUrl, "/api/workflows");
  if (!res.ok) {
    throw new JigsError(`workflows failed: HTTP ${res.status} ${await res.text()}`);
  }
  const result = (await res.json()) as { workflows: WorkflowSummary[] };
  if (result.workflows.length === 0) {
    deps.out("no workflows registered");
    return result.workflows;
  }
  for (const line of formatTable(
    ["WORKFLOW", "INPUTS"],
    result.workflows.map((workflow) => [workflow.name, inputSummary(workflow.inputs)]),
  )) {
    deps.out(line);
  }
  return result.workflows;
}

function inputSummary(schema: z.core.JSONSchema.BaseSchema): string {
  if (typeof schema.properties !== "object" || schema.properties === null)
    return "schema available";
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields = Object.entries(schema.properties);
  if (fields.length === 0) return "none";
  return fields
    .map(([name, raw]) => {
      const property = raw as Record<string, unknown>;
      const type = typeof property.type === "string" ? property.type : "value";
      const necessity = required.has(name) ? "required" : "optional";
      const defaultValue =
        property.default === undefined ? "" : `, default ${JSON.stringify(property.default)}`;
      const description =
        typeof property.description === "string" ? ` — ${singleLine(property.description)}` : "";
      return `${name} (${type}, ${necessity}${defaultValue})${description}`;
    })
    .join("; ");
}

const singleLine = (value: string): string => value.replace(/[\r\n\u2028\u2029]+/g, " ");
