import { STEP_TIMEOUT_ENV, stepTimeoutMs } from "jigs";
import {
  Agent,
  Dispatcher,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";

// Lifts the ceiling on how long one step may run. The ceiling is not ours:
// @workflow/world-postgres 4.3.4 runs every step by POSTing the step route and
// awaiting the response with a bare `fetch` and no dispatcher
// (dist/queue.js:223), so node's undici default `headersTimeout` of 300s
// aborts the request five minutes in, graphile-worker fails and redelivers the
// job (maxAttempts 3, exp(attempts)-second backoff), and a second agent starts
// against a worktree the first is still working in — the AGE-360 duplicates,
// whose step_started events landed 5:04 and 5:09 apart. world-postgres takes
// no config for this and `createWorld()` is called with no arguments, so the
// only reachable knob is the dispatcher node's global fetch uses.
//
// @workflow/world-local already does exactly this — its queue builds an Agent
// with `headersTimeout: 0`, "allows long-running steps" — and world-postgres
// was ported without it, which is why the ADR 0008 prototype's 600-second step
// passed.
//
// But the global dispatcher governs every outbound fetch in this process
// (GitHub, Linear, the agent providers), and those should still fail against a
// wedged server. So what is installed routes rather than overrides (AGE-364):
// the self-invocation gets no headers timeout at all, everything else keeps
// undici's own defaults, untouched.

export interface StepCeiling {
  // null is "wait as long as the step takes" — the default.
  timeoutMs: number | null;
  // The origins the World self-invokes on. Empty means the environment did
  // not name one; see matchesSelfOrigin.
  selfOrigins: string[];
}

export type DispatcherInstall = (ceiling: StepCeiling) => Promise<void> | void;

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// Mirrors @workflow/world-postgres's getExecutionBaseUrl (dist/queue.js:118):
// WORKFLOW_LOCAL_BASE_URL, else localhost on PORT. Its last resort — probing
// over HTTP for its own port — has no offline equivalent here, so that case
// resolves to nothing and matchesSelfOrigin widens instead.
export function selfOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const base = env.WORKFLOW_LOCAL_BASE_URL;
  if (base !== undefined && base !== "") {
    try {
      return [new URL(base).origin];
    } catch {
      // not a URL — fall through to PORT
    }
  }
  const port = env.PORT;
  if (port === undefined || port === "") return [];
  return [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
  ];
}

// Origin, never path: the step route's path belongs to the SDK
// (/.well-known/workflow/v1/step, under whatever base path the app is mounted
// on), while the origin is fixed by how the World addresses this process.
export function matchesSelfOrigin(origin: string, origins: string[]): boolean {
  if (origins.includes(origin)) return true;
  if (origins.length > 0) return false;
  // Nothing in the environment named this process's own address, so all that
  // is still known about the self-invocation is that it is loopback — which
  // nothing jigs calls out to ever is.
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

// A router, not a policy: `self` is the agent this dispatcher owns and `other`
// is whatever was global before it, kept intact so every request that is not
// the self-invocation behaves exactly as it did.
export class SelfOriginDispatcher extends Dispatcher {
  readonly #origins: string[];
  readonly #self: Dispatcher;
  readonly #other: Dispatcher;

  constructor(origins: string[], self: Dispatcher, other: Dispatcher) {
    super();
    this.#origins = origins;
    this.#self = self;
    this.#other = other;
  }

  override dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): boolean {
    const origin = options.origin === undefined ? "" : String(options.origin);
    const route = matchesSelfOrigin(origin, this.#origins)
      ? this.#self
      : this.#other;
    return route.dispatch(options, handler);
  }

  // Only the agent this dispatcher made: closing `other` would take the rest
  // of the process's fetch down with it.
  override async close(): Promise<void> {
    await this.#self.close();
  }

  override async destroy(): Promise<void> {
    await this.#self.destroy();
  }
}

const undiciGlobalDispatcher: DispatcherInstall = (ceiling) => {
  // Uncapped is world-local's own agent verbatim: headersTimeout 0, and
  // undici's default bodyTimeout left where it is — the wait is for the step
  // to finish, and its response body follows its headers immediately.
  const timeouts =
    ceiling.timeoutMs === null
      ? { headersTimeout: 0 }
      : { headersTimeout: ceiling.timeoutMs, bodyTimeout: ceiling.timeoutMs };
  // Userland undici and node's internal copy share
  // Symbol.for('undici.globalDispatcher.1'), and node installs its own only
  // lazily — so this is what `fetch` picks up.
  setGlobalDispatcher(
    new SelfOriginDispatcher(
      ceiling.selfOrigins,
      new Agent(timeouts),
      getGlobalDispatcher(),
    ),
  );
};

export function stepCeiling(env: NodeJS.ProcessEnv = process.env): StepCeiling {
  return { timeoutMs: stepTimeoutMs(env), selfOrigins: selfOrigins(env) };
}

export async function raiseStepCeiling(
  env: NodeJS.ProcessEnv = process.env,
  install: DispatcherInstall = undiciGlobalDispatcher,
): Promise<StepCeiling> {
  const ceiling = stepCeiling(env);
  await install(ceiling);
  return ceiling;
}

export function describeStepCeiling(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const { timeoutMs, selfOrigins: origins } = stepCeiling(env);
  const scope = origins[0] ?? "any loopback origin";
  const limit =
    timeoutMs === null
      ? "no limit"
      : `${timeoutMs / 60_000}m (${STEP_TIMEOUT_ENV})`;
  return `${limit} on the step route at ${scope}; undici defaults elsewhere`;
}
