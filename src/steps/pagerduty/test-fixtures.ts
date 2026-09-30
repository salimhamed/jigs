import { readFileSync } from "node:fs";
import { vi } from "vitest";
import type { PagerDutyIdentity } from "../../config/factory-config.ts";
import { createPagerDutyClient, type PagerDutyClient } from "../../providers/pagerduty.ts";

// Recorded from api.pagerduty.com against a sandbox incident, with the account
// and the responder's name replaced.
export const recorded = (name: "incident" | "note") =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

const IDENTITY: PagerDutyIdentity = {
  mode: "app",
  subdomain: "acme",
  region: "us",
  from: "oncall@example.com",
};

export interface RecordedCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: unknown;
}

/** A real client whose HTTP is answered by `respond`, so the steps run through it unchanged. */
export function recordedClient(respond: (call: RecordedCall) => unknown): {
  client: PagerDutyClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const call: RecordedCall = {
      method: init.method ?? "GET",
      url: new URL(input),
      headers: init.headers as Record<string, string>,
      body: init.body === undefined ? undefined : JSON.parse(init.body as string),
    };
    calls.push(call);
    return new Response(JSON.stringify(respond(call)), { status: 200 });
  });
  const client = createPagerDutyClient(IDENTITY, {
    auth: { identity: IDENTITY, bearer: async () => "token", invalidate: () => {} },
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  return { client, calls };
}
