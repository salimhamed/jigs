// What a factory declares its workflows with, re-exported from the "." export.

import { z } from "zod";
import type { WorkflowRequires } from "../checks/index.ts";
// The schemas that validate these sections, named for their types alone: a
// second hand-written copy of either would drift from what jigs accepts.
import type {
  bindingSchema,
  githubSchema,
  linearSchema,
  webhooksSchema,
} from "../config/factory-config.ts";
import { JigsError } from "./errors.ts";
import type { mergePolicySchema } from "./pull-requests/policy.ts";
import type { ReleasePolicy } from "./runtime/release.ts";

/** Accept a Linear issue UUID or an uppercase team-and-number ticket identifier. */
export const ticketInputSchema = z.union([z.uuid(), z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/)]);

/** Plaintext run metadata used by read-only tooling to resolve ticket selectors. */
export const RUN_TICKET_ATTRIBUTE = "$jigs.ticket";

// A driver sets or passes these itself, and a model credential comes from the
// model source; declaring one would override the subscription login or the
// invocation's private home.
export const RESERVED_AGENT_ENV: readonly string[] = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "PI_CODING_AGENT_DIR",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENROUTER_API_KEY",
];

const envName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name, never a value")
  .refine(
    (name) => !RESERVED_AGENT_ENV.includes(name),
    "is set by jigs or selects a model credential; name a model credential on its model source instead",
  );

// Names only: values stay in the service environment and are read when an
// agent starts, so none reaches the factory definition or workflow data.
export const agentsSchema = z.strictObject({ env: z.array(envName).default([]) });

/** Metadata supplied to every workflow run. */
export type Injected = { triggerId: string };

/** Parsed workflow inputs with the trigger that started the run. */
export type WorkflowInputs<S extends z.ZodType> = z.output<S> & Injected;

/** Ticket references are ordinary inputs; resolve them explicitly in a step. */
export type TicketWorkflowInputs<S extends z.ZodType<{ ticket: string }>> = WorkflowInputs<S>;

/**
 * A workflow: its function, its input schema, and what a run needs before it
 * may start.
 */
export interface WorkflowDefinition<S extends z.ZodType = z.ZodType> {
  inputs: S;
  /**
   * What the workflow needs before a run can start: the agents it runs, the
   * integrations, bindings and API model sources it uses. The service checks
   * the CLI of every agent's harness when it starts, and preflight checks
   * everything listed before every run. List only what the workflow uses.
   *
   * @example
   * ```ts
   * const agents = {
   *   builder: harnesses.claude("opus"),
   *   reviewer: harnesses.codex("gpt-5.6-sol"),
   * };
   *
   * export default defineWorkflow({
   *   inputs,
   *   requires: { agents, integrations: ["linear", "github"] },
   *   workflow: shipTicket,
   * });
   * ```
   */
  requires?: WorkflowRequires;
  release?: ReleasePolicy;
  workflow: (inputs: WorkflowInputs<S>) => Promise<unknown>;
}

/**
 * Declare a workflow as the default export of its file. It returns the
 * definition unchanged; it exists so TypeScript checks the workflow's
 * parameter against the input schema.
 *
 * @example
 * ```ts
 * const inputs = z.object({ binding: z.string() });
 *
 * export async function hello(input: WorkflowInputs<typeof inputs>) {
 *   "use workflow";
 *   // ...
 * }
 *
 * export default defineWorkflow({ inputs, workflow: hello });
 * ```
 */
export function defineWorkflow<S extends z.ZodType>(
  definition: WorkflowDefinition<S>,
): WorkflowDefinition<S> {
  return definition;
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous schemas per workflow
type AnyWorkflowDefinition = WorkflowDefinition<any>;

/** One recurring trigger: a workflow, when to fire it, and the inputs to
 *  fire it with. */
export interface Schedule {
  workflow: string;
  /** Five fields, evaluated in the service host's local time zone. */
  cron: string;
  inputs: Record<string, unknown>;
}

/**
 * What a factory repo hands the service: its workflows, keyed by name, and
 * the schedules that fire them. A schedule is keyed by its own name rather
 * than nested under a workflow — the name is what runs, status and `jigs
 * doctor` refer to, and one workflow can carry several.
 */
export interface Factory {
  workflows: Record<string, AnyWorkflowDefinition>;
  schedules?: Record<string, Schedule>;
  /** Which provider webhook routes the service mounts. Absent, it mounts none. */
  webhooks?: WebhooksDefinition;
}

/** Who jigs is on GitHub: the operator's own token, or a GitHub App installation. */
export type GitHubDefinition = z.input<typeof githubSchema>;

/**
 * Who jigs is on Linear: `key` acts as the user whose `LINEAR_API_KEY` is in
 * `.env`, `app` acts as a Linear OAuth application from `LINEAR_CLIENT_ID` and
 * `LINEAR_CLIENT_SECRET`. Defaults to `key`.
 *
 * @example
 * ```ts
 * linear: { identity: { mode: "app" } },
 * ```
 */
export type LinearDefinition = z.input<typeof linearSchema>;

/**
 * Where provider webhooks reach the service, and which providers send them.
 * Without this section the service still wakes parked runs by polling.
 *
 * @example
 * ```ts
 * webhooks: {
 *   url: "https://factory.example.ts.net",
 *   github: { enabled: true },
 *   linear: { enabled: false },
 * },
 * ```
 */
export type WebhooksDefinition = z.input<typeof webhooksSchema>;

/**
 * A repository this factory works in: its remote, how a worktree cut from it
 * is provisioned, and any merge settings that differ from the factory's.
 *
 * @example
 * ```ts
 * bindings: {
 *   api: {
 *     remote: "git@github.com:acme/api.git",
 *     postCreate: ["pnpm install"],
 *     merge: { by: "jigs", method: "rebase" },
 *   },
 * },
 * ```
 */
export type BindingDefinition = z.input<typeof bindingSchema>;

/** Who merges, by which of GitHub's three methods, and what signal permits it. */
export type MergeDefinition = z.input<typeof mergePolicySchema>;

/** Settings for the agent harnesses this factory runs. */
export interface AgentsDefinition {
  /**
   * Names of service environment variables every agent harness also receives.
   * A harness otherwise starts with only a small base set, such as `PATH` and
   * `HOME`, and the variables its own driver needs. Model credentials and
   * the variables jigs sets itself are refused: name a model credential on
   * its model source instead.
   */
  env?: string[];
}

/** Operating settings and deferred workflow modules declared by a factory. */
export interface FactoryDefinition {
  service: {
    port?: number;
    dashboardPort: number;
    /**
     * Seconds between the service's re-reads of each parked run, per
     * provider. Each defaults to 300 and may not go below 30. Up to a tenth
     * of the interval is taken off at random so services do not all poll at
     * once.
     */
    pollIntervalSeconds?: { github?: number; linear?: number };
  };
  agents?: AgentsDefinition;
  webhooks?: WebhooksDefinition;
  github?: GitHubDefinition;
  linear?: LinearDefinition;
  merge?: MergeDefinition;
  release?: ReleasePolicy;
  bindings?: Record<string, BindingDefinition>;
  workflows: Record<string, () => Promise<{ default: AnyWorkflowDefinition }>>;
  schedules?: Record<string, Schedule>;
}

/** Preserve the declaration's inferred keys without loading its workflows. */
export function defineFactory<const T extends FactoryDefinition>(factory: T): T {
  const agents = agentsSchema.safeParse(factory.agents ?? {});
  if (!agents.success)
    throw new JigsError(
      `invalid agents in defineFactory: ${agents.error.issues.map((issue) => `agents.${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  return factory;
}
