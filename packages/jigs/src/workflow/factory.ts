// What a factory declares its workflows with, re-exported from the "." export.

import { z } from "zod";
import type { WorkflowRequires } from "../checks/index.ts";
import {
  type agentsSchema,
  type bindingSchema,
  type factoryConfigSchema,
  type githubSchema,
  type linearSchema,
  parseFactoryConfig,
  type WorkflowImport,
} from "./factory-schema.ts";
import type { ReleasePolicy } from "./runtime/release.ts";

/**
 * Accept a Linear issue UUID or an uppercase team-and-number ticket identifier.
 *
 * @group Factory and workflows
 */
export const ticketInputSchema = z.union([z.uuid(), z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/)]);

/** Metadata supplied to every workflow run. */
export type Injected = { triggerId: string };

/**
 * Parsed workflow inputs with the trigger that started the run.
 *
 * @group Factory and workflows
 */
export type WorkflowInputs<S extends z.ZodType> = z.output<S> & Injected;

/**
 * Ticket references are ordinary inputs; resolve them explicitly in a step.
 *
 * @group Factory and workflows
 */
export type TicketWorkflowInputs<S extends z.ZodType<{ ticket: string }>> = WorkflowInputs<S>;

/**
 * A workflow: its function, its input schema, and what a run needs before it
 * may start.
 *
 * @group Factory and workflows
 */
export interface WorkflowDefinition<S extends z.ZodType = z.ZodType> {
  inputs: S;
  /**
   * What the workflow needs before a run can start: the agents it runs, the
   * integrations, bindings and API model sources it uses, and the names of the
   * environment variables its steps read as `secrets`. The service checks the
   * CLI of every agent's harness when it starts, and preflight checks
   * everything listed before every run. List only what the workflow uses.
   *
   * @remarks
   * A secret is set in the factory's environment and read in a step from the
   * process environment. The variables an agent's MCP servers name count as secrets
   * without being listed. Listing a secret does not pass it to agents.
   *
   * @example
   * Pass this value as `requires` when calling `defineWorkflow`.
   * ```ts
   * import { harnesses, type WorkflowDefinition } from "@jigs-ai/jigs";
   *
   * const agents = {
   *   builder: harnesses.claude({ model: "opus" }),
   *   reviewer: harnesses.codex({ model: "gpt-5.6-sol" }),
   * };
   *
   * const requires = {
   *   agents,
   *   integrations: ["linear", "github"],
   *   bindings: ["app"],
   *   secrets: ["SNOWFLAKE_TOKEN"],
   * } satisfies WorkflowDefinition["requires"];
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
 * import { defineWorkflow, type WorkflowInputs } from "@jigs-ai/jigs";
 * import { z } from "zod";
 *
 * const inputs = z.object({ name: z.string() });
 *
 * export async function hello(input: WorkflowInputs<typeof inputs>) {
 *   "use workflow";
 *   return `Hello, ${input.name}!`;
 * }
 *
 * export default defineWorkflow({ inputs, workflow: hello });
 * ```
 *
 * @group Factory and workflows
 */
export function defineWorkflow<S extends z.ZodType>(
  definition: WorkflowDefinition<S>,
): WorkflowDefinition<S> {
  return definition;
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous schemas per workflow
type AnyWorkflowDefinition = WorkflowDefinition<any>;

/** One recurring trigger: a workflow, when to fire it, and the inputs to
 *  fire it with. *
 * @group Factory and workflows
 */
export interface Schedule {
  /** An inactive schedule never fires. */
  active: boolean;
  workflow: string;
  /** Five fields, evaluated in the service host's local time zone. */
  cron: string;
  inputs: Record<string, unknown>;
}

/**
 * What an event trigger watches: a source kind and the provider's own query
 * parameters for it. Plain data, so it can sit in `jigs.config.ts`; a source's
 * constructor builds it.
 *
 * @group Factory and workflows
 */
export interface SourceDescriptor {
  kind: string;
  params: Record<string, unknown>;
}

/**
 * A trigger that starts one run per occurrence its source reports, at most
 * once per occurrence. Each run gets the reference the source hands it,
 * merged over the fixed `inputs`.
 *
 * @remarks
 * A new trigger starts from the moment the service first runs it, with no
 * backfill. After the service was down, it starts runs only for occurrences
 * within `lookbackMinutes` and records older ones as skipped.
 *
 * @group Factory and workflows
 */
export interface EventTrigger {
  /** An inactive trigger is not armed: its source's occurrences start no runs. */
  active: boolean;
  workflow: string;
  source: SourceDescriptor;
  inputs?: Record<string, unknown>;
  /** Runs of this trigger active at once. Defaults to 20; further occurrences wait, oldest first. */
  maxActive?: number;
  /** How far back to catch up after the service was down. Defaults to 60. */
  lookbackMinutes?: number;
}

/**
 * What a factory repo hands the service: its workflows, keyed by name, and
 * the schedules and event triggers that start them. A schedule is keyed by
 * its own name rather than nested under a workflow. The name is what runs,
 * status and `jigs doctor` refer to, and one workflow can carry several.
 *
 * @group Factory and workflows
 */
export interface Factory {
  workflows: Record<string, AnyWorkflowDefinition>;
  schedules?: Record<string, Schedule>;
  triggers?: Record<string, EventTrigger>;
}

/**
 * Who the operator is on GitHub, and how they approve a pull request for merging.
 *
 * @remarks
 * jigs acts on GitHub as the GitHub App the hub assigns this factory, so its pull requests come
 * from `<app-slug>[bot]` and the operator can approve them. `mergeApproval` defaults to `review`.
 *
 * @example
 * Use this value for `github` in `jigs.config.ts`.
 * ```ts
 * import type { GitHubDefinition } from "@jigs-ai/jigs";
 *
 * const github = {
 *   operator: "octocat",
 *   mergeApproval: "label",
 * } satisfies GitHubDefinition;
 * ```
 *
 * @group Factory and workflows
 */
export type GitHubDefinition = z.input<typeof githubSchema>;

/**
 * Who a ticket run's Linear questions and notes mention.
 *
 * @remarks
 * `operator` is the email of the Linear user who runs the factory. With it,
 * every question and note a ticket run posts mentions the operator and the
 * ticket's assignee; without it, the ticket's creator and assignee.
 * `jigs doctor` fails when no Linear user has the email. Steps read it from
 * the built factory, so a change takes effect after a rebuild, which
 * `jigs up` does.
 *
 * @example
 * Use this value for `linear` in `jigs.config.ts`.
 * ```ts
 * import type { LinearDefinition } from "@jigs-ai/jigs";
 *
 * const linear = {
 *   operator: "salim@example.com",
 * } satisfies LinearDefinition;
 * ```
 *
 * @group Factory and workflows
 */
export type LinearDefinition = z.input<typeof linearSchema>;

/**
 * A repository this factory works in: its remote, the GitHub installation
 * that reaches it, and how a worktree cut from it is provisioned.
 *
 * @remarks
 * `installationName` is the name an admin gave the GitHub App installation on
 * the hub. Pushes, pull requests and their events go through it.
 *
 * @example
 * Use this value for `bindings.api` in `jigs.config.ts`.
 * ```ts
 * import type { BindingDefinition } from "@jigs-ai/jigs";
 *
 * const api = {
 *   remote: "git@github.com:acme/api.git",
 *   installationName: "github-acme",
 *   postCreate: ["pnpm install"],
 * } satisfies BindingDefinition;
 * ```
 *
 * @group Factory and workflows
 */
export type BindingDefinition = z.input<typeof bindingSchema>;

/**
 * Settings for the agent harnesses this factory runs.
 *
 * @group Factory and workflows
 */
export type AgentsDefinition = z.input<typeof agentsSchema>;

/**
 * Operating settings and deferred workflow modules declared by a factory.
 *
 * @group Factory and workflows
 */
export type FactoryDefinition = z.input<typeof factoryConfigSchema> & {
  workflows: Record<string, WorkflowImport>;
};

/**
 * Check the declaration against what jigs accepts and preserve its inferred keys, without loading
 * its workflows.
 *
 * @group Factory and workflows
 */
export function defineFactory<const T extends FactoryDefinition>(
  // A generic parameter skips excess-property checks, so a misspelled section needs this to fail in tsc.
  factory: T & Record<Exclude<keyof T, keyof FactoryDefinition>, never>,
): T {
  parseFactoryConfig(factory);
  return factory;
}
