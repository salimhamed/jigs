// A thread reply that arrives over Socket Mode wakes the run waiting on that
// thread, if one is. Like every wake it is only a hint: the run reads the
// thread again, and the Slack poll covers a reply the socket missed.

import { slackThreadTokenFromEvent } from "../workflow/slack/thread-token.ts";
import { wake } from "./wake.ts";

/** Wake the run waiting on the thread this message replies in. True when one was woken. */
export async function wakeSlackThread(event: unknown): Promise<boolean> {
  const token = slackThreadTokenFromEvent(event);
  if (token === null) return false;
  // Most thread replies are in threads no run waits on, so `gone` is the usual answer.
  if ((await wake(token, "slack reply")).outcome !== "woken") return false;
  console.log(`[slack] woke ${token}`);
  return true;
}
