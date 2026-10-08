// The factory configuration's shape, as pure zod: `defineFactory` validates with it inside the
// workflow bundle, and the CLI and service parse `jigs.config.ts` with it.

import { z } from "zod";
import { JigsError } from "./errors.ts";
import type { EventTrigger, Schedule, WorkflowDefinition } from "./factory.ts";
import { mergeApprovalSchema } from "./pull-requests/policy.ts";
import { releaseSchema } from "./runtime/release.ts";

export const FACTORY_CONFIG_FILE = "jigs.config.ts";

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
export const agentsSchema = z.strictObject({
  /**
   * Names of service environment variables every agent harness also receives.
   * A harness otherwise starts with only a small base set, such as `PATH` and
   * `HOME`, and the variables its own driver needs. Model credentials and
   * the variables jigs sets itself are refused: name a model credential on
   * its model source instead.
   */
  env: z.array(envName).default([]),
});

/**
 * An installation's name, as an admin set it on the hub: lowercase letters, digits and hyphens,
 * starting with a letter. Use it for a workflow input that names an installation.
 *
 * @group Factory and workflows
 */
export const installationNameSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]*$/,
    "must be an installation name from the hub: lowercase letters, digits and hyphens, starting with a letter",
  );

// A binding is a name, a remote URL, and how a worktree cut from that remote
// is provisioned — the single place that story is told. Where the clone lives
// is jigs' business, and every other fact is derived from git at each activation.
export const bindingSchema = z.strictObject({
  remote: z.string().min(1),
  // The GitHub App installation, as named on the hub, that reaches the
  // remote's repository: pushes, pull requests and their wakes go through it.
  installationName: installationNameSchema,
  // Paths, or globs, relative to this binding's own `bindings/<name>/`
  // directory in the factory repo; each lands at that same relative path in
  // the worktree. For what git does not carry.
  copy: z.array(z.string()).default([]),
  postCreate: z.array(z.string()).default([]),
  hookTimeoutMinutes: z.number().positive().default(10),
});

const portSchema = z.int().min(1).max(65535);

const serviceSchema = z.strictObject({
  port: portSchema.default(8990),
  // Where this factory's service hosts the SDK's run dashboard. Required and
  // never derived: a default would silently land on another factory's service
  // port, and the two numbers have to be the operator's to move.
  dashboardPort: portSchema,
});

// jigs acts on GitHub as the App the hub assigns this factory, so pull requests
// come from `<app-slug>[bot]` and the operator can review them normally.
export const githubSchema = z.strictObject({
  /** The operator's GitHub login: assigned every pull request jigs opens, and named in its body. */
  operator: z.string().min(1).optional(),
  /** `Name <email>` added as a `Co-authored-by` trailer to the merge commits jigs makes. */
  coAuthor: z.string().min(1).optional(),
  /** How the operator approves a pull request for merging. */
  mergeApproval: mergeApprovalSchema.default("review"),
});

/**
 * A factory's Linear settings: optionally the operator, the Linear user's
 * email that every question and note a ticket run posts mentions together
 * with the ticket's assignee. jigs acts on Linear as the Linear app the hub assigns the factory.
 */
export const linearSchema = z.strictObject({
  operator: z.email().optional(),
});

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous schemas per workflow
export type WorkflowImport = () => Promise<{ default: WorkflowDefinition<any> }>;

const inputsSchema = z.record(z.string(), z.unknown());

const scheduleSchema: z.ZodType<Schedule, Schedule> = z.strictObject({
  workflow: z.string(),
  cron: z.string(),
  inputs: inputsSchema,
});

const eventTriggerSchema: z.ZodType<EventTrigger, EventTrigger> = z.strictObject({
  workflow: z.string(),
  source: z.strictObject({ kind: z.string(), params: inputsSchema }),
  inputs: inputsSchema.optional(),
  maxActive: z.number().optional(),
  lookbackMinutes: z.number().optional(),
});

// Strict so a misspelled section fails instead of falling back to defaults.
export const factoryConfigSchema = z
  .strictObject({
    bindings: z.record(z.string(), bindingSchema).default({}),
    // The hub this factory hears its providers through. Its token stays in
    // .env as JIGS_HUB_TOKEN.
    hub: z.strictObject({ url: z.url() }),
    // One service per factory repo, so the addresses belong to the factory
    // rather than the machine. Only non-secret operating parameters live here —
    // the World the service writes is a credential-bearing URL, so it stays in
    // the factory's own .env. An absent section is read as an empty one, so what
    // it is missing reports itself by name.
    service: z.preprocess<unknown, typeof serviceSchema, z.input<typeof serviceSchema>>(
      (section) => section ?? {},
      serviceSchema,
    ),
    // Who the operator is on GitHub, and how they approve a merge.
    github: githubSchema.prefault({}),
    linear: linearSchema.prefault({}),
    release: releaseSchema.optional(),
    // Service variables every agent harness receives beyond jigs' base set.
    agents: agentsSchema.prefault({}),
    // Deferred imports: calling one loads the workflow, which only the service does.
    workflows: z
      .record(
        z.string(),
        z.custom<WorkflowImport>((load) => typeof load === "function", "must be a deferred import"),
      )
      .optional(),
    schedules: z.record(z.string(), scheduleSchema).optional(),
    triggers: z.record(z.string(), eventTriggerSchema).optional(),
  })
  .superRefine(checkStarts);

/** Runs of an event trigger active at once when it does not say. */
export const DEFAULT_MAX_ACTIVE = 20;
/** Minutes an event trigger catches up after downtime when it does not say. */
export const DEFAULT_LOOKBACK_MINUTES = 60;

// What needs neither a loaded workflow nor the service's sources. The service
// checks the rest: the cron, the source and its params, and the inputs.
function checkStarts(
  {
    workflows = {},
    schedules = {},
    triggers = {},
  }: {
    workflows?: Record<string, WorkflowImport>;
    schedules?: Record<string, Schedule>;
    triggers?: Record<string, EventTrigger>;
  },
  ctx: z.RefinementCtx,
): void {
  const problem = (path: string[], reason: string, repair: string) =>
    ctx.addIssue({ code: "custom", path, message: `${reason}\n${repair}` });
  // A run's trigger id appends the tick or occurrence to the name after a ":",
  // and the trigger column and a schedule's overlap skip read the name back by
  // splitting on the first one, so a name carrying its own would answer for
  // another's runs.
  const name = (kind: "schedule" | "trigger", key: string) => {
    if (!key.includes(":")) return;
    problem(
      [`${kind}s`, key],
      `${kind} name "${key}" contains ":"`,
      `rename the "${key}" ${kind} in jigs.config.ts to a name without ":"\na run's trigger id is read back out of the name`,
    );
  };
  const workflow = (at: string[], chosen: string) => {
    if (Object.hasOwn(workflows, chosen)) return;
    problem(
      [...at, "workflow"],
      `workflow "${chosen}" is not one of this factory's workflows`,
      `set ${at.join(".")}.workflow in jigs.config.ts to one of: ${Object.keys(workflows).join(", ")}`,
    );
  };
  for (const [key, schedule] of Object.entries(schedules)) {
    name("schedule", key);
    workflow(["schedules", key], schedule.workflow);
  }
  for (const [key, trigger] of Object.entries(triggers)) {
    const at = ["triggers", key];
    name("trigger", key);
    workflow(at, trigger.workflow);
    const { maxActive, lookbackMinutes } = trigger;
    if (maxActive !== undefined && (!Number.isInteger(maxActive) || maxActive < 1))
      problem(
        [...at, "maxActive"],
        `maxActive ${maxActive} is not a whole number of at least 1`,
        `set triggers.${key}.maxActive in jigs.config.ts to 1 or more, or remove it for the default of ${DEFAULT_MAX_ACTIVE}`,
      );
    if (
      lookbackMinutes !== undefined &&
      (!Number.isFinite(lookbackMinutes) || lookbackMinutes <= 0)
    )
      problem(
        [...at, "lookbackMinutes"],
        `lookbackMinutes ${lookbackMinutes} is not a positive number of minutes`,
        `set triggers.${key}.lookbackMinutes in jigs.config.ts above 0, or remove it for the default of ${DEFAULT_LOOKBACK_MINUTES}`,
      );
  }
}

export type BindingEntry = z.output<typeof bindingSchema>;

// The binding as everything downstream sees it: the operator's entry with its
// provisioning defaults applied, plus the name the caller asked for.
export interface Binding extends BindingEntry {
  name: string;
}

export type FactoryConfig = z.output<typeof factoryConfigSchema>;

export function parseFactoryConfig(value: unknown): FactoryConfig {
  const result = factoryConfigSchema.safeParse(value);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message.replaceAll("\n", "\n    ")}`,
    );
    throw new JigsError(`invalid ${FACTORY_CONFIG_FILE}:\n  ${lines.join("\n  ")}`);
  }
  return result.data;
}
