// A thread reply that arrives over Socket Mode wakes the run waiting on that
// thread, if one is. Like every wake it is only a hint: the run reads the
// thread again, and the Slack poll covers a reply the socket missed.

import { resumeHook } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { slackThreadTokenFromEvent } from "../workflow/slack/thread-token.ts";

/** Resume the hook of the thread this message replies in. True when a run was waiting on it. */
export async function wakeSlackThread(
  event: unknown,
  resume: (token: string) => Promise<unknown> = (token) => resumeHook(token, undefined),
): Promise<boolean> {
  const token = slackThreadTokenFromEvent(event);
  if (token === null) return false;
  try {
    await resume(token);
  } catch (error) {
    // Most thread replies are in threads no run waits on.
    if (HookNotFoundError.is(error)) return false;
    throw error;
  }
  console.log(`[slack] woke ${token}`);
  return true;
}
