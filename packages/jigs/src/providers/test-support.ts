// Provider tests inject this as the client's fetch instead of stubbing the global.

export interface FetchCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  /** The request body as sent. */
  body?: string;
  /** The body parsed as JSON, when it is JSON. */
  json?: unknown;
}

/** A fetch that records each call and answers it with `handle`. */
export function fakeFetch(handle: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const doFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? init.body : undefined;
    let json: unknown;
    try {
      json = body === undefined ? undefined : JSON.parse(body);
    } catch {}
    const call: FetchCall = {
      method: init.method ?? "GET",
      url: new URL(String(input)),
      headers: { ...(init.headers as Record<string, string> | undefined) },
      ...(body === undefined ? {} : { body }),
      ...(json === undefined ? {} : { json }),
    };
    calls.push(call);
    return handle(call);
  };
  return { fetch: doFetch as typeof fetch, calls };
}

/** A JSON response. */
export const jsonResponse = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response => new Response(JSON.stringify(body), { status, headers });

/** A sleep that records each wait and returns at once. */
export function fakeSleep() {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return { sleep, sleeps };
}
