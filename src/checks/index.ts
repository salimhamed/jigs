import {
  FACTORY_CONFIG_FILE,
  type LinearIdentity,
  type PagerDutyIdentity,
  readFactoryConfig,
  resolveService,
  type SlackConfig,
} from "../config/factory-config.ts";
import { factoryRoot } from "../config/factory-root.ts";
import { otherSlackAppHolders } from "../config/slack-apps.ts";
import { JigsError } from "../errors.ts";
import { getAuthenticatedUser } from "../providers/github.ts";
import { resolveGithubIdentities } from "../providers/github-auth.ts";
import { findUserByEmail, getViewer } from "../providers/linear.ts";
import { resolveLinearIdentity } from "../providers/linear-auth.ts";
import { pagerDutyClientFor } from "../providers/pagerduty.ts";
import { pagerDutyAuthFor, resolvePagerDutyIdentity } from "../providers/pagerduty-auth.ts";
import { slackAuthTest, slackEnvValue, slackOpenConnection } from "../providers/slack.ts";
import { driverFor, type HarnessTarget } from "../steps/agents/drivers/index.ts";
import { agentStepEnv, factoryAgentEnv } from "../steps/agents/harnesses/env.ts";
import { readsAgentGithubToken } from "../workflow/agents/github-mcp.ts";
import type { AskableModelSource, Harness } from "../workflow/agents/harness-config.ts";
import { agentCommandCheck, agentGithubChecks } from "./agent-github.ts";
import { awsCredentialsCheck } from "./aws.ts";
import { bindingChecks } from "./bindings.ts";
import {
  CHECK_TIMEOUT_MS,
  type Check,
  type CheckReport,
  failedCheck,
  neededByUsers,
  requirementUsers,
  runChecks,
  type WorkflowManifests,
} from "./catalog.ts";
import { type Integration, RESTART_SERVICE } from "./core.ts";
import {
  type GithubIdentityProbes,
  githubIdentityChecks,
  realGithubIdentityProbes,
} from "./github-identity.ts";
import {
  harnessChecks,
  harnessUsers,
  missingDriverCheck,
  requiredHarnessKinds,
  usedHarnessChecks,
} from "./harnesses.ts";
import {
  type LinearIdentityProbes,
  linearIdentityChecks,
  linearOperatorChecks,
} from "./linear-identity.ts";
import { linearWebhookChecks } from "./linear-webhook.ts";
import { mcpServerChecks } from "./mcp.ts";
import {
  type PagerDutyIdentityProbes,
  pagerDutyFromChecks,
  pagerDutyIdentityChecks,
} from "./pagerduty-identity.ts";
import { pagerDutyWebhookChecks } from "./pagerduty-webhook.ts";
import { doctorSecretChecks, secretChecks } from "./secrets.ts";
import {
  type SlackProbes,
  slackIdentityChecks,
  slackSharedAppChecks,
  slackSocketModeChecks,
} from "./slack.ts";
import { webhookChecks } from "./webhooks.ts";

export { type BindingChecksOptions, bindingChecks } from "./bindings.ts";
export {
  CHECK_TIMEOUT_MS,
  type Check,
  type CheckOutcome,
  type CheckReport,
  type CheckResult,
  type FailedCheck,
  failedCheck,
  failedChecks,
  formatFailures,
  runChecks,
} from "./catalog.ts";
export { RESTART_SERVICE, SERVICE_ENV_FILE } from "./core.ts";
export {
  type GithubIdentityCheckOptions,
  type GithubIdentityProbes,
  githubIdentityChecks,
  realGithubIdentityProbes,
} from "./github-identity.ts";
export {
  type HarnessRuntime,
  type HarnessRuntimeDeps,
  harnessRuntime,
  harnessRuntimes,
} from "./harness-runtime.ts";
export {
  claudeAuthCheck,
  codexAuthCheck,
  type HarnessKind,
  harnessChecks,
  harnessRuntimeCheck,
} from "./harnesses.ts";
export {
  type LinearIdentityProbes,
  type LinearOperatorProbes,
  linearIdentityChecks,
  linearOperatorChecks,
} from "./linear-identity.ts";
export { codexWorktreeConfigCheck, mcpServerChecks } from "./mcp.ts";
export {
  type PagerDutyIdentityProbes,
  type PagerDutyUserProbes,
  pagerDutyFromChecks,
  pagerDutyIdentityChecks,
} from "./pagerduty-identity.ts";
export {
  doctorSecretChecks,
  type SecretChecksOptions,
  secretChecks,
} from "./secrets.ts";
export { type SlackProbes, slackIdentityChecks, slackSocketModeChecks } from "./slack.ts";
export { type WebhookChecksOptions, webhookChecks } from "./webhooks.ts";

// A workflow's declared requirements — the manifest side of the computed check
// list. Hand-maintaining the list is the drift trap this exists to avoid.
export interface WorkflowRequires {
  agents?: Record<string, Harness>;
  integrations?: Integration[];
  bindings?: string[];
  models?: AskableModelSource[];
  aws?: true;
  // Environment variable names, never values.
  secrets?: string[];
}

// The real provider clients, so a caller of the catalog states only its own
// requirements. Substituting a probe stays a seam on each check factory.
const linearProbes: LinearIdentityProbes = { viewer: getViewer };
const githubProbes: GithubIdentityProbes = realGithubIdentityProbes(getAuthenticatedUser);
const pagerDutyProbes: PagerDutyIdentityProbes = {
  token: async () => {
    await pagerDutyAuthFor().bearer();
  },
  read: () => pagerDutyClientFor().verifyAccess(),
};
const slackProbes: SlackProbes = { authTest: slackAuthTest, openConnection: slackOpenConnection };

// Which credential jigs holds and what it is allowed to do with it. Both come
// from `jigs.config.ts`; where there is none to read, the defaults are what a
// factory would get, and the credential is still worth checking.
function githubChecks(): Check[] {
  try {
    const { webhooks } = readFactoryConfig(factoryRoot());
    return githubIdentityChecks(resolveGithubIdentities(), githubProbes, process.env, {
      webhooks: webhooks?.github.enabled ?? false,
    });
  } catch {
    // A configuration that cannot be read is the binding checks' diagnosis;
    // the credential is still worth checking, against what a factory that
    // states nothing would get.
    return githubIdentityChecks([{ mode: "pat" }], githubProbes);
  }
}

// A configuration that cannot be read says nothing about the credential, so it
// fails as itself rather than as a key Linear rejected.
function linearChecks(): Check[] {
  let identity: LinearIdentity;
  try {
    identity = resolveLinearIdentity();
  } catch (err) {
    return [
      failedCheck(
        "linear.identity",
        "Linear identity",
        err instanceof Error ? err.message : String(err),
        `repair ${FACTORY_CONFIG_FILE}, then: \`${RESTART_SERVICE}\``,
      ),
    ];
  }
  return linearIdentityChecks(identity, linearProbes);
}

// The bot token is worth checking whatever the config says, so a missing or
// unreadable slack section falls back to no Socket Mode and no extra scopes.
// An unreadable config is the binding checks' diagnosis.
function configuredSlack(): SlackConfig {
  let slack: SlackConfig | undefined;
  try {
    slack = readFactoryConfig(factoryRoot()).slack;
  } catch {}
  return slack ?? { socketMode: false, scopes: [] };
}

function slackDoctorChecks(): Check[] {
  const slack = configuredSlack();
  return [
    ...slackIdentityChecks(slackProbes, slack.scopes),
    ...slackSocketModeChecks(slack, slackProbes),
    ...slackSharedAppChecks(slack, otherSlackAppServices),
  ];
}

function otherSlackAppServices(): string[] {
  const token = slackEnvValue("SLACK_APP_TOKEN");
  if (token === undefined) return [];
  const { slug } = resolveService(factoryRoot());
  return otherSlackAppHolders(token, slug).map((holder) => holder.slug);
}

// An unreadable config is the identity check's diagnosis, so it adds nothing here.
function linearOperatorDoctorChecks(): Check[] {
  let identity: LinearIdentity;
  let operator: string | undefined;
  try {
    identity = resolveLinearIdentity();
    operator = readFactoryConfig(factoryRoot()).linear.operator;
  } catch {
    return [];
  }
  return linearOperatorChecks(identity, operator, {
    viewer: getViewer,
    userByEmail: findUserByEmail,
  });
}

// A missing or unreadable pagerduty section fails as itself, with the section
// to add, rather than as a credential PagerDuty rejected.
function pagerDutyChecks(): Check[] {
  let identity: PagerDutyIdentity;
  try {
    identity = resolvePagerDutyIdentity();
  } catch (err) {
    return [
      failedCheck(
        "pagerduty.identity",
        "PagerDuty identity",
        err instanceof Error ? err.message : String(err),
        err instanceof JigsError && err.hint !== undefined
          ? err.hint
          : `repair ${FACTORY_CONFIG_FILE}, then: \`${RESTART_SERVICE}\``,
      ),
    ];
  }
  return pagerDutyIdentityChecks(identity, pagerDutyProbes);
}

// An unreadable config is the identity check's diagnosis, so it adds nothing here.
function pagerDutyFromDoctorChecks(): Check[] {
  let identity: PagerDutyIdentity;
  try {
    identity = resolvePagerDutyIdentity();
  } catch {
    return [];
  }
  return pagerDutyFromChecks(identity, {
    token: pagerDutyProbes.token,
    userByEmail: (email) => pagerDutyClientFor().findUserByEmail(email),
  });
}

export function preflightChecks(
  requires: WorkflowRequires,
  inputs?: Record<string, unknown>,
): Check[] {
  const integrations = requires.integrations ?? [];
  // A binding selected by this run is more specific than the workflow's
  // static requirements. Workflows without a binding input retain the fixed
  // binding list declared in their manifest.
  const bindings =
    typeof inputs?.binding === "string" ? [inputs.binding] : (requires.bindings ?? []);
  return [
    ...(integrations.includes("linear") ? linearChecks() : []),
    ...(integrations.includes("github") ? githubChecks() : []),
    ...(integrations.includes("pagerduty") ? pagerDutyChecks() : []),
    ...(integrations.includes("slack")
      ? slackIdentityChecks(slackProbes, configuredSlack().scopes)
      : []),
    ...bindingChecks({ factoryRoot, names: bindings }),
    ...harnessChecks(requiredHarnessKinds(requires)),
    ...agentGithubChecks(Object.values(requires.agents ?? {})),
    ...(requires.models ?? []).flatMap((source) => {
      const driver = driverFor(source.kind);
      if (driver === undefined) return [missingDriverCheck(source.kind)];
      return [...driver.installationChecks(), ...(driver.descriptorChecks?.(source) ?? [])];
    }),
    ...(requires.aws ? [awsCredentialsCheck()] : []),
    ...secretChecks(requires, { factoryRoot }),
  ];
}

// Beyond what a workflow requires, the configuration can ask for a provider
// itself: a binding or a GitHub webhook needs GitHub, a Linear webhook needs
// Linear, a PagerDuty webhook needs PagerDuty, and an App identity, a pagerduty
// section or a slack section is set up on purpose. The key and PAT identities
// are what every scaffold states, so they ask for nothing. An unreadable config
// asks for nothing either: the binding checks report it.
function configuredProviders(): Record<Integration, boolean> {
  try {
    const { bindings, webhooks, github, linear, pagerduty, slack } = readFactoryConfig(
      factoryRoot(),
    );
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

// Doctor has no worktree, so it starts the servers from the factory root.
function requiredMcpServerChecks(workflows: WorkflowManifests): Check[] {
  let root: string;
  let agentEnv: readonly string[];
  try {
    root = factoryRoot();
    agentEnv = factoryAgentEnv();
  } catch {
    // The binding checks report a configuration that cannot be read.
    return [];
  }
  const servers = new Map<string, { checks: Check[]; workflows: string[] }>();
  for (const [workflow, { requires }] of Object.entries(workflows)) {
    for (const harness of Object.values(requires?.agents ?? {})) {
      // A kind with no driver is the harness checks' diagnosis.
      const driver = driverFor(harness.kind);
      if (driver === undefined) continue;
      for (const [name, server] of Object.entries(harness.mcpServers ?? {})) {
        const key = JSON.stringify([harness.kind, name, server, harness.github !== undefined]);
        const entry = servers.get(key) ?? {
          checks: serverChecks(name, () => {
            // The agent's GitHub token exists only inside its step, so doctor
            // checks the server is installed; the step's own check probes it.
            if (readsAgentGithubToken(server) && "command" in server)
              return [
                agentCommandCheck(
                  `mcp.${name}`,
                  `MCP server ${name}`,
                  server.command,
                  `install ${server.command} on the PATH the service starts agents with`,
                ),
              ];
            return agentMcpServerChecks(
              harness.kind,
              { [name]: server },
              root,
              agentStepEnv(driver, { harness, cwd: root }, agentEnv),
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

// Claude Code and Codex pass a step's environment on to a stdio server; Pi's
// adapter starts it from its declaration alone.
function agentMcpServerChecks(
  kind: Harness["kind"],
  servers: Harness["mcpServers"],
  cwd: string,
  env: Record<string, string>,
): Check[] {
  return mcpServerChecks(servers ?? {}, cwd, env, { inherit: kind !== "pi" });
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
  triggers: Record<string, Integration> = {},
): Check[] {
  const users = requirementUsers(workflows, (requires) => [
    ...(requires.integrations ?? []),
    ...(requires.aws ? (["aws"] as const) : []),
  ]);
  const configured = configuredProviders();
  const provider = (name: Integration, checks: () => Check[]): Check[] => {
    const needing = users.get(name) ?? [];
    const polling = Object.keys(triggers).filter((trigger) => triggers[trigger] === name);
    return needing.length > 0 || polling.length > 0 || configured[name]
      ? neededByUsers(checks(), needing, polling)
      : [];
  };
  const aws = users.get("aws") ?? [];
  return [
    ...provider("linear", () => [...linearChecks(), ...linearOperatorDoctorChecks()]),
    ...provider("github", githubChecks),
    ...provider("pagerduty", () => [...pagerDutyChecks(), ...pagerDutyFromDoctorChecks()]),
    ...provider("slack", slackDoctorChecks),
    // Keyed on the config rather than the Linear credential: a Linear webhook
    // switched on without its secret is a failure even where that is missing too.
    ...linearWebhookChecks({ factoryRoot }),
    ...pagerDutyWebhookChecks({
      factoryRoot,
      probes: {
        token: pagerDutyProbes.token,
        subscriptions: (url) => pagerDutyClientFor().listWebhookSubscriptions({ url }),
      },
    }),
    ...bindingChecks({ factoryRoot }),
    ...webhookChecks({ factoryRoot }),
    ...usedHarnessChecks(harnessUsers(workflows)),
    ...usedAgentGithubChecks(workflows),
    ...requiredMcpServerChecks(workflows),
    ...(aws.length > 0 ? neededByUsers([awsCredentialsCheck()], aws) : []),
    ...doctorSecretChecks(workflows, { factoryRoot }),
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
    ...(driver?.jitChecks?.(target) ?? []),
    ...agentMcpServerChecks(harness.kind, harness.mcpServers, target.cwd, env),
  ];
}
