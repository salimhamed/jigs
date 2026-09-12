// What a factory declares its workflows with, re-exported from the "." export.

import { z } from "zod";
import type { WorkflowRequires } from "../checks/index.ts";

export const ticketInput = z.union([
  z.uuid(),
  z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/),
]);

/** What the trigger injects beside a workflow's own parsed inputs. Exported
 *  for the trigger to `satisfies` its injected object against: the workflow
 *  types below are built from these two, so a field on one side and not the
 *  other fails to compile. */
export type Injected = { triggerId: string };
export type TicketInjected = Injected & {
  issueId: string;
  identifier: string;
};

/** What a workflow body is handed: its own parsed inputs plus the `triggerId`
 *  the trigger injects on every run. */
export type WorkflowInputs<S extends z.ZodType> = z.output<S> & Injected;

/** The same for a workflow whose inputs carry a `ticket`: the trigger resolves
 *  the ref against Linear and injects the resolved pair, so the body reads it
 *  rather than resolving the ticket again. The constraint is the honest half —
 *  a schema with no required `ticket` gets nothing resolved. */
export type TicketWorkflowInputs<S extends z.ZodType<{ ticket: string }>> =
  z.output<S> & TicketInjected;

export interface WorkflowEntry<S extends z.ZodType = z.ZodType> {
  workflow: (
    inputs: z.output<S> &
      (z.output<S> extends { ticket: string } ? TicketInjected : Injected),
  ) => Promise<unknown>;
  inputs: S;
  // The manifest half of preflight's computed check list.
  requires?: WorkflowRequires;
}

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
 * than nested under a workflow — the name is what runs, logs and `jigs
 * doctor` refer to, and one workflow can carry several.
 */
export interface Factory {
  workflows: Record<string, AnyWorkflowEntry>;
  schedules?: Record<string, Schedule>;
}

/** Operating settings and deferred workflow modules declared by a factory. */
export interface FactoryDefinition {
  service: { port?: number; dashboardPort: number };
  ingressUrl?: string;
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
export function defineFactory<const T extends FactoryDefinition>(
  factory: T,
): T {
  return factory;
}
