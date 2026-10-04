// The one request loop behind every provider's HTTP API: credential, send, one
// re-mint on a rejected credential, bounded waits on a rate limit, and a
// provider-owned decode that turns any answer into a value or a failure.

import { JigsError } from "../errors.ts";

export type Provider = "github" | "linear" | "pagerduty" | "slack";

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

/** A provider answered a call with a failure: an error status, or a refusal in its body. */
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
  auth: ProviderAuth;
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
  /** Seconds a 429 asks to wait. Defaults to `retry-after`, else 1. */
  retryAfter?: (res: Response) => number;
  /**
   * Every answer not retried, including a 429 the loop gave up on, becomes a value or a thrown
   * failure here. Defaults to `jsonDecode`.
   */
  decode?: (res: Response, text: string, fail: Fail) => T;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** A JSON body on success, nothing on 204, and a failure for any error status. */
function jsonDecode<T>(res: Response, text: string, fail: Fail): T {
  if (!res.ok) throw fail();
  return (res.status === 204 || text === "" ? undefined : JSON.parse(text)) as T;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryAfterHeader(res: Response): number {
  const seconds = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
  return Number.isNaN(seconds) ? 1 : seconds;
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
    const credential = await spec.auth.bearer();
    const res = await doFetch(spec.url, {
      method,
      headers: {
        authorization: spec.authorization?.(credential) ?? `Bearer ${credential}`,
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
      spec.auth.invalidate &&
      (spec.isAuthFailure?.(res, text) ?? res.status === 401)
    ) {
      reauthorized = true;
      spec.auth.invalidate(credential);
      continue;
    }
    if (res.status === 429) {
      const wait = (spec.retryAfter ?? retryAfterHeader)(res);
      if (wait > MAX_RATE_LIMIT_WAIT_SECONDS) detail = `rate limited for ${wait}s`;
      else if (rateLimited < RATE_LIMIT_RETRIES) {
        rateLimited += 1;
        await sleep(wait * 1000);
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
