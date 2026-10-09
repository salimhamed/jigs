// What `jigs status` and doctor show for a factory's event triggers.

import {
  type Check,
  failedCheck,
  failedChecks,
  type TriggerInstallation,
} from "../../checks/index.ts";
import { currentFactoryContext } from "../../config/factory-context.ts";
import { registrySql } from "../../steps/runtime/registry.ts";
import type { Factory } from "../../workflow/factory.ts";
import { liveRunsByAttribute, OCCURRENCE_ATTRIBUTE, runStatuses } from "../runs.ts";
import { tally } from "./capacity.ts";
import { SOURCES, type SourceRegistry } from "./sources.ts";
import { type TriggerStore, triggerStore } from "./store.ts";
import { resolveTrigger } from "./validate.ts";

const FAILURES_SHOWN = 5;

/** One failed occurrence, with the checks that refused its run. */
export interface TriggerFailure {
  occurrence: string;
  at: string;
  checks: Array<{ label: string; reason: string; repair: string }>;
}

/** Operator-facing state for one declared event trigger. */
export interface TriggerView {
  name: string;
  workflow: string;
  source: string;
  lastOccurrence: string | null;
  pending: number;
  active: number;
  failed: number;
  /** The most recent failures, newest first. */
  failures: TriggerFailure[];
}

/** Injectable storage, run reads and clock used by the trigger listing. */
export interface ListTriggersDeps {
  store?: TriggerStore;
  liveRunsByAttribute?: typeof liveRunsByAttribute;
  runStatuses?: typeof runStatuses;
  now?: () => Date;
}

/** What `jigs status` shows for each declared trigger, valid or not. */
export async function listTriggers(
  factory: Factory,
  deps: ListTriggersDeps = {},
): Promise<TriggerView[]> {
  const declared = Object.entries(factory.triggers ?? {});
  if (declared.length === 0) return [];
  const store = deps.store ?? triggerStore(registrySql(), currentFactoryContext().slug);
  const liveRuns = deps.liveRunsByAttribute ?? liveRunsByAttribute;
  const now = (deps.now ?? (() => new Date()))();
  return Promise.all(
    declared.map(async ([name, trigger]) => {
      const entry = factory.workflows[trigger.workflow] as Factory["workflows"][string];
      const live = await liveRuns(
        (entry.workflow as { workflowId?: string }).workflowId,
        OCCURRENCE_ATTRIBUTE,
      );
      const [summary, { active }] = await Promise.all([
        store.summary(name, FAILURES_SHOWN),
        tally(store, name, live, deps.runStatuses ?? runStatuses, now),
      ]);
      return {
        name,
        workflow: trigger.workflow,
        source: trigger.source.kind,
        lastOccurrence: summary.lastOccurrence?.toISOString() ?? null,
        pending: summary.pending,
        active,
        failed: summary.failed,
        failures: summary.failures.map((row) => ({
          occurrence: row.occurrence,
          at: row.updatedAt.toISOString(),
          checks: row.report === null ? [] : failedChecks(row.report),
        })),
      };
    }),
  );
}

/**
 * Doctor's half: the same validations the engine refuses a trigger on, and for a valid trigger its
 * recent failed occurrences with their repairs.
 */
export function triggerChecks(
  factory: Factory,
  sources: SourceRegistry = SOURCES,
  deps: { store?: () => TriggerStore } = {},
): Check[] {
  return Object.entries(factory.triggers ?? {}).flatMap(([name, trigger]): Check[] => {
    const id = `trigger.${name}`;
    const label = `trigger ${name}`;
    const resolved = resolveTrigger(factory, name, trigger, sources);
    if ("reason" in resolved) return [failedCheck(id, label, resolved.reason, resolved.repair)];
    return [
      { id, label, run: async (): Promise<{ ok: true }> => ({ ok: true }) },
      {
        id: `${id}.failed`,
        label: `trigger ${name} occurrences`,
        // A note, not a failure: each failed occurrence waits on the operator,
        // and `jigs up`, which ends with doctor, must not refuse over one.
        run: async () => {
          const store = deps.store?.() ?? triggerStore(registrySql(), currentFactoryContext().slug);
          const summary = await store.summary(name, FAILURES_SHOWN);
          if (summary.failed === 0) return { ok: true };
          return {
            ok: true,
            detail: [
              `${summary.failed} failed, each waiting on the operator`,
              ...summary.failures.flatMap((row) =>
                (row.report === null ? [] : failedChecks(row.report)).flatMap((check) => [
                  `${row.occurrence}: ${check.reason}`,
                  // Plain text: backticks mark commands only in rendered hints.
                  ...check.repair.split("\n").map((line) => `  ${line.replaceAll("`", "")}`),
                ]),
              ),
            ].join("\n"),
          };
        },
      },
    ];
  });
}

/**
 * Each declared trigger whose source this jigs version provides, with the
 * provider it reads and the installation it names.
 */
export function triggerInstallations(
  factory: Factory,
  sources: SourceRegistry = SOURCES,
): Record<string, TriggerInstallation> {
  return Object.fromEntries(
    Object.entries(factory.triggers ?? {}).flatMap(([name, trigger]) => {
      const source = sources[trigger.source.kind];
      if (source === undefined) return [];
      const { installationName } = trigger.source.params;
      return [
        [
          name,
          {
            provider: source.provider,
            ...(typeof installationName === "string" ? { installationName } : {}),
          },
        ],
      ];
    }),
  );
}
