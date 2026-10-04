// What every provider's request loop shares: its error, the rate-limit wait and
// the one re-mint on a rejected credential. Each provider sends and decodes in
// its own file.

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
  /** Forget `stale` if it is still cached. Without it a rejected credential is not retried. */
  invalidate?(stale: string): void;
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
 * Wait out a rate limit asking for `seconds`, after `waited` earlier waits on the same call, and
 * say whether to send it again: not for a wait over a minute, nor past the third. `watch` ends the
 * wait early with its signal's reason, such as the run's cancellation; `null` waits regardless.
 */
export async function rateLimitWait(
  provider: Provider,
  seconds: number,
  waited: number,
  watch: WaitSignal | null,
  sleep: Sleep = realSleep,
): Promise<boolean> {
  if (seconds > MAX_RATE_LIMIT_WAIT_SECONDS || waited >= RATE_LIMIT_RETRIES) return false;
  const ms = seconds * 1000;
  if (watch === null) {
    await sleep(ms);
    return true;
  }
  const run = await watch(`waiting out ${PROVIDER_NAMES[provider]}'s rate limit`);
  try {
    if (run?.signal.aborted) throw abortReason(run.signal);
    await abortable(sleep(ms, run?.signal), run?.signal);
  } finally {
    run?.dispose();
  }
  return true;
}

/**
 * Forget a rejected credential so the next `bearer()` mints a fresh one, and say whether to send
 * again. A credential that cannot be re-minted, such as a personal key, is not retried.
 */
export function reauthorize(auth: ProviderAuth, stale: string): boolean {
  if (auth.invalidate === undefined) return false;
  // A long-lived token can be revoked early, by a re-mint with other scopes.
  auth.invalidate(stale);
  return true;
}

export interface ClientCredentialsGrant {
  provider: Provider;
  url: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  /** The hint on a refusal. */
  hint: string;
  /** What of a refusal's body to quote; the secret is then cut out of it. */
  quote: (body: string) => string;
  fetch?: typeof fetch;
}

/** Exchange an OAuth app's client credentials for a token, keeping the secret out of any failure. */
export async function mintClientCredentials(
  grant: ClientCredentialsGrant,
): Promise<{ accessToken: string; expiresIn?: unknown }> {
  const name = PROVIDER_NAMES[grant.provider];
  const doFetch = grant.fetch ?? fetch;
  let waits = 0;
  for (;;) {
    const res = await doFetch(grant.url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: grant.clientId,
        client_secret: grant.clientSecret,
        scope: grant.scope,
      }).toString(),
    });
    const text = await res.text();
    // One mint serves every run waiting on it, so no run's cancellation ends its wait.
    if (
      res.status === 429 &&
      (await rateLimitWait(grant.provider, retryAfterSeconds(res), waits++, null))
    ) {
      continue;
    }
    if (!res.ok) {
      const detail = grant.quote(text).replaceAll(grant.clientSecret, "[redacted]");
      throw new JigsError(
        `${name} refused a client-credentials token (HTTP ${res.status})${detail ? `: ${detail}` : ""}`,
        grant.hint,
      );
    }
    let body: { access_token?: unknown; expires_in?: unknown };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new JigsError(`${name}'s token response (HTTP ${res.status}) was not JSON`);
    }
    if (typeof body.access_token !== "string" || body.access_token === "") {
      throw new JigsError(`${name}'s token response carried no access_token`);
    }
    return { accessToken: body.access_token, expiresIn: body.expires_in };
  }
}
