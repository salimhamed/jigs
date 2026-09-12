import { Agent, Dispatcher, getGlobalDispatcher, setGlobalDispatcher } from "undici";

// The World runs every step by POSTing the step route with a bare `fetch`, so
// undici's default 300s headersTimeout aborts any step past five minutes and
// the job is redelivered into a worktree the first agent is still working in.
// @workflow/world-local's own queue answers this with `headersTimeout: 0`;
// world-postgres was ported without it and takes no config, so the only
// reachable knob is the global dispatcher.
//
// That dispatcher governs every outbound fetch in the process, and GitHub,
// Linear and the agent providers should still fail against a wedged server —
// hence a router rather than an override.

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
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`];
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
    const route = matchesSelfOrigin(origin, this.#origins) ? this.#self : this.#other;
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

// The self agent is world-local's verbatim: headersTimeout 0, and undici's
// default bodyTimeout left where it is — the wait is for the step to finish,
// and its response body follows its headers immediately.
//
// Userland undici and node's internal copy share
// Symbol.for('undici.globalDispatcher.1'), and node installs its own only
// lazily — so this is what `fetch` picks up.
export function raiseStepCeiling(env: NodeJS.ProcessEnv = process.env): void {
  setGlobalDispatcher(
    new SelfOriginDispatcher(
      selfOrigins(env),
      new Agent({ headersTimeout: 0 }),
      getGlobalDispatcher(),
    ),
  );
}

export function describeStepCeiling(env: NodeJS.ProcessEnv = process.env): string {
  const scope = selfOrigins(env)[0] ?? "any loopback origin";
  return `uncapped on the step route at ${scope}; undici defaults elsewhere`;
}
