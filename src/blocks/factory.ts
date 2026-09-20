// What a factory declares its workflows with, re-exported from the "." export.

import { z } from "zod";
import type { WorkflowRequires } from "../checks/index.ts";
// The schemas that validate these blocks, named for their types alone: a
// second hand-written copy of either would drift from what jigs accepts.
import type { githubSchema } from "../config/factory-config.ts";
import type { mergePolicySchema } from "./pull-requests/policy.ts";
import type { ReleasePolicy } from "./runtime/release.ts";

/** Accept a Linear issue UUID or an uppercase team-and-number ticket identifier. */
export const ticketInputSchema = z.union([z.uuid(), z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/)]);

/** Plaintext run metadata used by read-only tooling to resolve ticket selectors. */
export const RUN_TICKET_ATTRIBUTE = "$jigs.ticket";

/** Metadata supplied to every workflow run. */
export type Injected = { triggerId: string };

/** Parsed workflow inputs with the trigger that started the run. */
export type WorkflowInputs<S extends z.ZodType> = z.output<S> & Injected;

/** Ticket references are ordinary inputs; resolve them explicitly in a step. */
export type TicketWorkflowInputs<S extends z.ZodType<{ ticket: string }>> = WorkflowInputs<S>;

/** A factory-owned workflow together with its input schema and runtime requirements. */
export interface WorkflowEntry<S extends z.ZodType = z.ZodType> {
  workflow: (inputs: WorkflowInputs<S>) => Promise<unknown>;
  inputs: S;
  // The manifest half of preflight's computed check list.
  requires?: WorkflowRequires;
  release?: ReleasePolicy;
}

/** A workflow entry used where a factory contains several different input schemas. */
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous schemas per entry
export type AnyWorkflowEntry = WorkflowEntry<any>;

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
  workflows: Record<string, AnyWorkflowEntry>;
  schedules?: Record<string, Schedule>;
}

/** Who jigs is on GitHub: the operator's own token, or a GitHub App installation. */
export type GitHubDefinition = z.input<typeof githubSchema>;

/** Who merges, by which of GitHub's three methods, and what signal permits it. */
export type MergeDefinition = z.input<typeof mergePolicySchema>;

/** Operating settings and deferred workflow modules declared by a factory. */
export interface FactoryDefinition {
  service: { port?: number; dashboardPort: number };
  ingressUrl?: string;
  github?: GitHubDefinition;
  merge?: MergeDefinition;
  release?: ReleasePolicy;
  bindings?: Record<
    string,
    {
      remote: string;
      copy?: string[];
      postCreate?: string[];
      hookTimeoutMinutes?: number;
    }
  >;
  workflows: Record<string, () => Promise<{ default: AnyWorkflowEntry }>>;
  schedules?: Record<string, Schedule>;
}

/** Preserve the declaration's inferred keys without loading its workflows. */
export function defineFactory<const T extends FactoryDefinition>(factory: T): T {
  return factory;
}
