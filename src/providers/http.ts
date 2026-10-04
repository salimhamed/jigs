// The one request loop behind every provider's HTTP API: credential, send, one
// re-mint on a rejected credential, bounded waits on a rate limit, and a
// provider-owned decode that turns any answer into a value or a failure.

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
const MAX_RATE_LIMIT_WAIT_SECONDS = 60;
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

/** Builds the failure for this response, with provider, status, request and body filled in. */
export type Fail = (
  extra?: Pick<ProviderApiErrorInit, "code" | "detail" | "message">,
) => ProviderApiError;

export interface ProviderRequest<T> {
  provider: Provider;
  /** Absent for a call that sends no credential, such as a token exchange. */
  auth?: ProviderAuth;
  url: string;
  method?: string;
  /** Names the call in a failure; defaults to the method and the URL's path. */
  request?: string;
  headers?: Record<string, string>;
  /** Sent JSON-encoded, with its content type. */
  json?: unknown;
  /** Sent as is; set its content type in `headers`. */
  body?: string;
  /** The `authorization` header for a credential. Defaults to `Bearer <credential>`. */
  authorization?: (credential: string) => string;
  /** Whether the provider rejected the credential. Defaults to a 401. */
  isAuthFailure?: (res: Response, text: string) => boolean;
  /** Whether the answer is a rate limit to wait out. Defaults to a 429. */
  isRateLimited?: (res: Response) => boolean;
  /** Seconds a rate limit asks to wait. Defaults to `retry-after`, else 1. */
  retryAfter?: (res: Response) => number;
  /**
   * Every answer not retried, including a rate limit the loop gave up on, becomes a value or a thrown
   * failure here. Defaults to `jsonDecode`.
   */
  decode?: (res: Response, text: string, fail: Fail) => T;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Ends a rate-limit wait early, failing with the signal's reason. Without one, a call made from
   * a step ends its wait when that step's run is cancelled; `null` never ends it, for work shared
   * between runs such as a token mint.
   */
  signal?: AbortSignal | null;
}

/** A JSON body on success, nothing on 204, and a failure for any error status. */
function jsonDecode<T>(res: Response, text: string, fail: Fail): T {
  if (!res.ok) throw fail();
  return (res.status === 204 || text === "" ? undefined : JSON.parse(text)) as T;
}

const realSleep = (ms: number, signal?: AbortSignal) =>
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

function retryAfterHeader(res: Response): number {
  const seconds = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
  return Number.isNaN(seconds) ? 1 : seconds;
}

// Imported on demand, so the CLI, which runs where the workflow SDK may not be
// installed, never loads it.
async function watchCallingRun(subject: string) {
  let cancellation: typeof import("../run-cancellation.ts");
  try {
    cancellation = await import("../run-cancellation.ts");
  } catch {
    return undefined;
  }
  return cancellation.watchCallingRun(subject);
}

async function waitOut(
  ms: number,
  spec: Pick<ProviderRequest<unknown>, "provider" | "signal">,
  sleep: NonNullable<ProviderRequest<unknown>["sleep"]>,
): Promise<void> {
  if (spec.signal === null) return sleep(ms);
  const watch =
    spec.signal === undefined
      ? await watchCallingRun(`waiting out ${PROVIDER_NAMES[spec.provider]}'s rate limit`)
      : undefined;
  const signal = spec.signal ?? watch?.signal;
  try {
    if (signal?.aborted) throw abortReason(signal);
    await abortable(sleep(ms, signal), signal);
  } finally {
    watch?.dispose();
  }
}

export async function providerRequest<T>(spec: ProviderRequest<T>): Promise<T> {
  const method = spec.method ?? "GET";
  const request = spec.request ?? `${method} ${new URL(spec.url).pathname}`;
  const doFetch = spec.fetch ?? fetch;
  const sleep = spec.sleep ?? realSleep;
  const decode = spec.decode ?? jsonDecode<T>;
  let reauthorized = false;
  let rateLimited = 0;
  for (;;) {
    const credential = await spec.auth?.bearer();
    const res = await doFetch(spec.url, {
      method,
      headers: {
        ...(credential === undefined
          ? {}
          : { authorization: spec.authorization?.(credential) ?? `Bearer ${credential}` }),
        ...(spec.json === undefined ? {} : { "content-type": "application/json" }),
        ...spec.headers,
      },
      body: spec.json === undefined ? spec.body : JSON.stringify(spec.json),
    });
    const text = await res.text();
    let detail: string | undefined;
    // A long-lived token can be revoked early, by a re-mint with other scopes.
    if (
      !reauthorized &&
      credential !== undefined &&
      spec.auth?.invalidate &&
      (spec.isAuthFailure?.(res, text) ?? res.status === 401)
    ) {
      reauthorized = true;
      spec.auth.invalidate(credential);
      continue;
    }
    if (spec.isRateLimited?.(res) ?? res.status === 429) {
      const wait = (spec.retryAfter ?? retryAfterHeader)(res);
      if (wait > MAX_RATE_LIMIT_WAIT_SECONDS) detail = `rate limited for ${wait}s`;
      else if (rateLimited < RATE_LIMIT_RETRIES) {
        rateLimited += 1;
        await waitOut(wait * 1000, spec, sleep);
        continue;
      }
    }
    const fail: Fail = (extra = {}) =>
      new ProviderApiError({
        provider: spec.provider,
        status: res.status,
        request,
        body: text,
        detail,
        ...extra,
      });
    return decode(res, text, fail);
  }
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
export function mintClientCredentials(
  grant: ClientCredentialsGrant,
): Promise<{ accessToken: string; expiresIn?: unknown }> {
  const name = PROVIDER_NAMES[grant.provider];
  return providerRequest({
    provider: grant.provider,
    url: grant.url,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: grant.clientId,
      client_secret: grant.clientSecret,
      scope: grant.scope,
    }).toString(),
    fetch: grant.fetch,
    // One mint serves every run waiting on it.
    signal: null,
    decode: (res, text) => {
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
    },
  });
}
