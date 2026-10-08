// What every provider's request loop shares: its error, its credential and the
// rate-limit wait. Each provider sends and decodes in its own file.

import { JigsError } from "../errors.ts";

import type { Provider } from "../workflow/providers.ts";

export type { Provider };

const PROVIDER_NAMES: Record<Provider, string> = {
  github: "GitHub",
  linear: "Linear",
  pagerduty: "PagerDuty",
  slack: "Slack",
};

const RATE_LIMIT_RETRIES = 3;
// A wait longer than this belongs to the caller's schedule, not a blocked call.
export const MAX_RATE_LIMIT_WAIT_SECONDS = 60;
const MAX_ERROR_BODY = 1_000;

/** Where a provider call's credential comes from. */
export interface ProviderAuth {
  bearer(): Promise<string>;
  /** Forget `stale` if it is still cached, so the next `bearer()` asks the hub for a fresh one. */
  invalidate(stale: string): void;
}

export interface ProviderApiErrorInit {
  provider: Provider;
  status: number;
  /** The call, as `METHOD /path` or a method name, without its query. */
  request: string;
  body: string;
  code?: string;
  /** Replaces the body in the message. */
  detail?: string;
  /** Replaces the whole message. */
  message?: string;
}

/**
 * A provider answered a call with a failure: an error status, or a refusal in its body.
 *
 * @group Errors
 */
export class ProviderApiError extends JigsError {
  readonly provider: Provider;
  readonly status: number;
  readonly code?: string;
  readonly body: string;

  constructor(init: ProviderApiErrorInit) {
    super(
      init.message ??
        `${PROVIDER_NAMES[init.provider]} API ${init.status} on ${init.request}: ${init.detail ?? init.body.slice(0, MAX_ERROR_BODY)}`,
    );
    this.name = "ProviderApiError";
    this.provider = init.provider;
    this.status = init.status;
    this.code = init.code;
    this.body = init.body;
  }
}

/** A watch for one wait, started when the wait begins and disposed when it ends. */
export type WaitSignal = (
  subject: string,
) => Promise<{ signal: AbortSignal; dispose(): void } | undefined>;

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

const realSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
  });

const abortReason = (signal: AbortSignal): unknown => signal.reason ?? new JigsError("cancelled");

/** `promise`, or a rejection with the signal's reason as soon as `signal` aborts. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** The seconds a rate limit's `retry-after` asks to wait, else `fallback`. */
export function retryAfterSeconds(res: Response, fallback = 1): number {
  const seconds = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
  return Number.isNaN(seconds) ? fallback : seconds;
}

/**
 * The waits of one call. `wait(seconds)` waits out a rate limit, or another `reason` to send again,
 * and says whether to send the call again: not for a wait over a minute, nor past the third. `watch`
 * ends a wait early with its signal's reason, such as the run's cancellation; `null` waits
 * regardless.
 */
export function rateLimitWaits(
  provider: Provider,
  watch: WaitSignal | null,
  sleep: Sleep = realSleep,
): { wait(seconds: number, reason?: string): Promise<boolean> } {
  let waited = 0;
  return {
    async wait(seconds, reason = "rate limit") {
      if (seconds > MAX_RATE_LIMIT_WAIT_SECONDS || waited >= RATE_LIMIT_RETRIES) return false;
      waited += 1;
      const ms = seconds * 1000;
      if (watch === null) {
        await sleep(ms);
        return true;
      }
      const run = await watch(`waiting out ${PROVIDER_NAMES[provider]}'s ${reason}`);
      try {
        if (run?.signal.aborted) throw abortReason(run.signal);
        await abortable(sleep(ms, run?.signal), run?.signal);
      } finally {
        run?.dispose();
      }
      return true;
    },
  };
}
