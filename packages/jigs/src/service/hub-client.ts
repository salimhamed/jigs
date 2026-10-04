// How the service hears from its providers through the hub: long-poll the
// factory's messages, route each in order, then confirm the last one. A message
// is confirmed even when routing it failed, so one bad event never blocks every
// later one; a wake carries nothing, so a lost one costs what a lost webhook did.

import {
  cursorPath,
  type Message,
  type MessagesResponse,
  maxWaitSeconds,
  messagesPath,
} from "@jigs-ai/hub-protocol";
import { PROVIDERS } from "../workflow/providers.ts";
import { type NudgeDeps, nudgeProvider } from "./nudge.ts";
import { type RouteDeps, routeProviderEvent } from "./provider-events.ts";

const MAX_BACKOFF_MS = 60_000;
const UNAUTHORIZED_RETRY_MS = 5 * 60_000;
// Room past the hub's own wait before a silent connection counts as dead.
const POLL_GRACE_MS = 15_000;

export interface HubClientOptions {
  url: string;
  token: string;
  version: string;
  route: RouteDeps;
  nudge?: NudgeDeps;
}

class HubResponseError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`the hub answered ${status}`);
    this.status = status;
  }
}

/** Milliseconds to wait after this many failures in a row: doubling from a second, capped at a minute. */
export function hubBackoff(failures: number): number {
  return Math.min(1000 * 2 ** (failures - 1), MAX_BACKOFF_MS);
}

/** Poll the hub until stopped. `stop` aborts the request in flight and resolves once the loop has exited. */
export function startHubClient(options: HubClientOptions): { stop: () => Promise<void> } {
  const controller = new AbortController();
  const done = run(options, controller.signal);
  return {
    stop: () => {
      controller.abort();
      return done;
    },
  };
}

async function run(options: HubClientOptions, signal: AbortSignal): Promise<void> {
  const request = async (path: string, init: RequestInit, timeoutMs?: number) => {
    const response = await fetch(new URL(path, options.url), {
      ...init,
      headers: {
        ...init.headers,
        authorization: `Bearer ${options.token}`,
        "user-agent": `jigs/${options.version}`,
      },
      signal:
        timeoutMs === undefined
          ? signal
          : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (!response.ok) throw new HubResponseError(response.status);
    return response;
  };
  const confirm = (position: string) =>
    request(cursorPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ position }),
    });

  let unconfirmed: string | null = null;
  let failures = 0;
  while (!signal.aborted) {
    try {
      if (unconfirmed !== null) {
        await confirm(unconfirmed);
        unconfirmed = null;
      }
      const response = await request(
        `${messagesPath}?wait=${maxWaitSeconds}`,
        {},
        maxWaitSeconds * 1000 + POLL_GRACE_MS,
      );
      const { messages } = (await response.json()) as MessagesResponse;
      if (failures > 0) console.log("[hub] reconnected");
      failures = 0;
      const last = messages.at(-1);
      if (last === undefined) continue;
      for (const message of messages) await handle(message, options);
      unconfirmed = last.position;
      await confirm(unconfirmed);
      unconfirmed = null;
    } catch (error) {
      if (signal.aborted) return;
      failures += 1;
      if (error instanceof HubResponseError && error.status === 401) {
        console.error(
          "[hub] the hub rejected the factory token; no provider events reach this factory until it is accepted",
        );
        await sleep(UNAUTHORIZED_RETRY_MS, signal);
      } else {
        const delay = hubBackoff(failures);
        console.error(
          `[hub] could not reach the hub, retrying in ${delay / 1000}s: ${String(error)}`,
        );
        await sleep(delay, signal);
      }
    }
  }
}

async function handle(message: Message, options: HubClientOptions): Promise<void> {
  if (message.kind === "fellBehind") {
    console.error(
      "[hub] the hub dropped provider events this factory never received; waking every waiting run to re-read its provider",
    );
    for (const provider of PROVIDERS) await nudgeProvider(provider, options.nudge);
    return;
  }
  const { id, provider, name, payload } = message.event;
  const failed = (reason: string) =>
    console.error(
      `[hub] could not route ${provider} event ${id} (${name}); runs waiting on it will not hear of it until their provider is read again: ${reason}`,
    );
  try {
    const result = await routeProviderEvent({ provider, name, payload }, options.route);
    if (result.outcome === "failed") failed("routing failed");
  } catch (error) {
    failed(String(error));
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
