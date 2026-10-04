import path from "node:path";
import { currentFactoryContext, type FactoryContext } from "../config/factory-context.ts";
import { JigsError } from "../errors.ts";
import { githubChecks } from "../providers/github-checks.ts";
import { webhookChecks } from "../providers/github-webhook-checks.ts";
import { linearChecks, linearOperatorDoctorChecks } from "../providers/linear-checks.ts";
import { linearWebhookChecks } from "../providers/linear-webhook-checks.ts";
import {
  pagerDutyChecks,
  pagerDutyFromDoctorChecks,
  pagerDutyWebhookProbes,
} from "../providers/pagerduty-checks.ts";
import { pagerDutyWebhookChecks } from "../providers/pagerduty-webhook-checks.ts";
import { slackChecks, slackDoctorChecks } from "../providers/slack-checks.ts";
import { driverFor, type HarnessTarget } from "../steps/agents/shared/drivers.ts";
import { agentStepEnv, factoryAgentEnv } from "../steps/agents/shared/env.ts";
import { AGENT_ACCESS_PROVIDERS, agentTokensReadBy } from "../workflow/agents/agent-access.ts";
import type { AskableModelSource, Harness } from "../workflow/agents/harness-config.ts";
import type { Provider } from "../workflow/providers.ts";
import { agentCommandCheck, agentGithubChecks } from "./agent-github.ts";
import { awsCredentialsCheck } from "./aws.ts";
import { bindingChecks } from "./bindings.ts";
import {
  CHECK_TIMEOUT_MS,
  type CheckReport,
  neededByUsers,
  requirementUsers,
  runChecks,
  type WorkflowManifests,
} from "./catalog.ts";
import { type Check, failedCheck } from "./check.ts";
import { descriptorChecks, requiredDescriptors, usedDescriptorChecks } from "./harnesses.ts";
import { mcpServerChecks } from "./mcp.ts";
import { doctorSecretChecks, secretChecks } from "./secrets.ts";
import { skillChecks } from "./skills.ts";

export {
  type CheckReport,
  type FailedCheck,
  failedChecks,
  formatFailures,
  runChecks,
} from "./catalog.ts";
export { type Check, failedCheck } from "./check.ts";

// A workflow's declared requirements — the manifest side of the computed check
// list. Hand-maintaining the list is the drift trap this exists to avoid.
export interface WorkflowRequires {
  agents?: Record<string, Harness>;
  integrations?: Provider[];
  bindings?: string[];
  models?: AskableModelSource[];
  aws?: true;
  // Environment variable names, never values.
  secrets?: string[];
}

// An agent that acts as the factory on a provider needs that provider's
// identity, as a step that calls it does.
function integrationsOf(requires: WorkflowRequires): Provider[] {
  const agents = Object.values(requires.agents ?? {});
  const opted = AGENT_ACCESS_PROVIDERS.filter((provider) =>
    agents.some((agent) => agent[provider] !== undefined),
  );
  return [...new Set([...(requires.integrations ?? []), ...opted])];
}

export function preflightChecks(
  requires: WorkflowRequires,
  inputs?: Record<string, unknown>,
  ctx: FactoryContext = currentFactoryContext(),
): Check[] {
  const integrations = integrationsOf(requires);
  // A binding selected by this run is more specific than the workflow's
  // static requirements. Workflows without a binding input retain the fixed
  // binding list declared in their manifest.
  const bindings =
    typeof inputs?.binding === "string" ? [inputs.binding] : (requires.bindings ?? []);
  return [
    ...(integrations.includes("linear") ? linearChecks(ctx) : []),
    ...(integrations.includes("github") ? githubChecks(ctx) : []),
    ...(integrations.includes("pagerduty") ? pagerDutyChecks(ctx) : []),
    ...(integrations.includes("slack") ? slackChecks(ctx) : []),
    ...bindingChecks({ context: ctx, names: bindings }),
    ...descriptorChecks(requiredDescriptors(requires)),
    ...agentGithubChecks(Object.values(requires.agents ?? {})),
    ...declaredSkillChecks({ workflow: { requires } }).flatMap(({ checks }) => checks),
    ...(requires.aws ? [awsCredentialsCheck()] : []),
    ...secretChecks(requires, { context: ctx }),
  ];
}

// Beyond what a workflow requires, the configuration can ask for a provider
// itself: a binding or a GitHub webhook needs GitHub, a Linear webhook needs
// Linear, a PagerDuty webhook needs PagerDuty, and an App identity, a pagerduty
// section or a slack section is set up on purpose. The key and PAT identities
// are what every scaffold states, so they ask for nothing. An unreadable config
// asks for nothing either: the binding checks report it.
function configuredProviders(ctx: FactoryContext): Record<Provider, boolean> {
  try {
    const { bindings, webhooks, github, linear, pagerduty, slack } = ctx.config;
    return {
      github:
        Object.keys(bindings).length > 0 ||
        (webhooks?.github.enabled ?? false) ||
        github.identities.some((identity) => identity.mode === "app"),
      linear:
        (webhooks?.linear.enabled ?? false) ||
        linear.identity.mode === "app" ||
        linear.operator !== undefined,
      pagerduty: pagerduty !== undefined || (webhooks?.pagerduty.enabled ?? false),
      slack: slack !== undefined,
    };
  } catch {
    return { github: false, linear: false, pagerduty: false, slack: false };
  }
}

function usedAgentGithubChecks(workflows: WorkflowManifests): Check[] {
  const opted = Object.entries(workflows).flatMap(([workflow, { requires }]) =>
    Object.values(requires?.agents ?? {})
      .filter((agent) => agent.github !== undefined)
      .map((agent) => ({ workflow, agent })),
  );
  return neededByUsers(agentGithubChecks(opted.map(({ agent }) => agent)), [
    ...new Set(opted.map(({ workflow }) => workflow)),
  ]);
}

// A skill check's outcome depends on the earlier entries in its list that
// could clash with it by name, so checks share a key only when those match.
function declaredSkillChecks(
  workflows: WorkflowManifests,
): { checks: Check[]; workflows: string[] }[] {
  const base = (entry: string) => path.basename(path.normalize(entry));
  const entries = new Map<string, { checks: Check[]; workflows: string[] }>();
  for (const [workflow, { requires }] of Object.entries(workflows)) {
    for (const harness of Object.values(requires?.agents ?? {})) {
      const skills = harness.skills ?? [];
      skills.forEach((entry, index) => {
        const rivals = skills.slice(0, index).filter((other) => base(other) === base(entry));
        const key = JSON.stringify([entry, rivals]);
        const found = entries.get(key) ?? {
          checks: skillChecks([...rivals, entry]).slice(-1),
          workflows: [],
        };
        if (!found.workflows.includes(workflow)) found.workflows.push(workflow);
        entries.set(key, found);
      });
    }
  }
  return [...entries.values()];
}

// Doctor has no worktree, so it starts the servers from the factory root.
function requiredMcpServerChecks(workflows: WorkflowManifests, ctx: FactoryContext): Check[] {
  const { root } = ctx;
  let agentEnv: readonly string[];
  try {
    agentEnv = factoryAgentEnv(ctx);
  } catch {
    // The binding checks report a configuration that cannot be read.
    return [];
  }
  const servers = new Map<string, { checks: Check[]; workflows: string[] }>();
  for (const [workflow, { requires }] of Object.entries(workflows)) {
    for (const harness of Object.values(requires?.agents ?? {})) {
      const driver = driverFor(harness.kind);
      for (const [name, server] of Object.entries(harness.mcpServers ?? {})) {
        const key = JSON.stringify([harness.kind, name, server, harness.github !== undefined]);
        const entry = servers.get(key) ?? {
          checks: serverChecks(name, () => {
            // An agent token exists only inside its step, so doctor checks a
            // local server is installed; the step's own check probes it.
            if (agentTokensReadBy(server).length > 0)
              return "command" in server
                ? [
                    agentCommandCheck(
                      `mcp.${name}`,
                      `MCP server ${name}`,
                      server.command,
                      `install ${server.command} on the PATH the service starts agents with`,
                    ),
                  ]
                : [];
            return mcpServerChecks(
              { [name]: server },
              root,
              agentStepEnv(driver, { harness, cwd: root }, agentEnv),
              {
                inherit: driver.mcpInheritsEnv === true,
              },
            );
          }),
          workflows: [],
        };
        if (!entry.workflows.includes(workflow)) entry.workflows.push(workflow);
        servers.set(key, entry);
      }
    }
  }
  return [...servers.values()].flatMap(({ checks, workflows }) => neededByUsers(checks, workflows));
}

// A descriptor whose environment cannot be planned fails the way the step
// would, as the server's check rather than as the whole report.
function serverChecks(name: string, build: () => Check[]): Check[] {
  try {
    return build();
  } catch (err) {
    return [
      failedCheck(
        `mcp.${name}`,
        `MCP server ${name}`,
        err instanceof Error ? err.message : String(err),
        err instanceof JigsError && err.hint !== undefined
          ? err.hint
          : "fix the agent's harness descriptor in the workflow's requires.agents",
      ),
    ];
  }
}

/** Run doctor's checks, giving each MCP probe the allowance a step gives it. */
export function runDoctorChecks(checks: Check[]): Promise<CheckReport> {
  return Promise.all(
    checks.map((check) =>
      runChecks([check], check.id.startsWith("mcp.") ? JIT_TIMEOUT_MS : CHECK_TIMEOUT_MS),
    ),
  ).then((reports) => {
    const outcomes = reports.flatMap((report) => report.checks);
    return { ok: outcomes.every((outcome) => outcome.ok), checks: outcomes };
  });
}

// Every check follows the factory: its workflows' manifests, the providers its
// event triggers poll, and its configuration. A provider, harness or AWS
// profile nothing uses is not checked. `triggers` maps each trigger to the
// provider its source reads.
export function doctorChecks(
  workflows: WorkflowManifests,
  triggers: Record<string, Provider> = {},
  ctx: FactoryContext = currentFactoryContext(),
): Check[] {
  const users = requirementUsers(workflows, (requires) => [
    ...integrationsOf(requires),
    ...(requires.aws ? (["aws"] as const) : []),
  ]);
  const configured = configuredProviders(ctx);
  const provider = (name: Provider, checks: () => Check[]): Check[] => {
    const needing = users.get(name) ?? [];
    const polling = Object.keys(triggers).filter((trigger) => triggers[trigger] === name);
    return needing.length > 0 || polling.length > 0 || configured[name]
      ? neededByUsers(checks(), needing, polling)
      : [];
  };
  const aws = users.get("aws") ?? [];
  return [
    ...provider("linear", () => [...linearChecks(ctx), ...linearOperatorDoctorChecks(ctx)]),
    ...provider("github", () => githubChecks(ctx)),
    ...provider("pagerduty", () => [...pagerDutyChecks(ctx), ...pagerDutyFromDoctorChecks(ctx)]),
    ...provider("slack", () => slackDoctorChecks(ctx)),
    // Keyed on the config rather than the Linear credential: a Linear webhook
    // switched on without its secret is a failure even where that is missing too.
    ...linearWebhookChecks({ context: ctx }),
    ...pagerDutyWebhookChecks({ context: ctx, probes: pagerDutyWebhookProbes(ctx) }),
    ...bindingChecks({ context: ctx }),
    ...webhookChecks({ context: ctx }),
    ...usedDescriptorChecks(workflows),
    ...usedAgentGithubChecks(workflows),
    ...requiredMcpServerChecks(workflows, ctx),
    ...declaredSkillChecks(workflows).flatMap(({ checks, workflows }) =>
      neededByUsers(checks, workflows),
    ),
    ...(aws.length > 0 ? neededByUsers([awsCredentialsCheck()], aws) : []),
    ...doctorSecretChecks(workflows, { context: ctx }),
  ];
}

// Strictly larger than the sum of the MCP check's three phase budgets
// (connect, listTools, callTool), so a slow server is diagnosed by the phase
// that timed out rather than pre-empted by the outer race into a generic
// "did not answer".
export const JIT_TIMEOUT_MS = 3 * CHECK_TIMEOUT_MS + 5_000;

// Preflight's backstop: everything a step can only learn at hydration, once
// the body has built its harness config — which no manifest could declare
// ahead of the run. `env` is the environment the step hands its harness.
export function jitChecks(target: HarnessTarget, env: Record<string, string>): Check[] {
  const harness = target.harness;
  const driver = driverFor(harness.kind);
  return [
    ...(driver.jitChecks?.(target) ?? []),
    ...skillChecks(harness.skills ?? []),
    ...mcpServerChecks(harness.mcpServers ?? {}, target.cwd, env, {
      inherit: driver.mcpInheritsEnv === true,
    }),
  ];
}
