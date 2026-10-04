/**
 * Low-level Slack operations for factory-owned steps. Workflow code calls their
 * `#jigs/steps` wrappers; waiting for a thread reply is `waitForSlackReply`
 * from `#jigs/routines`. `callSlack` reaches any other Web API method from a
 * factory's own `"use step"` function.
 *
 * See [Slack](https://salimhamed.github.io/jigs/guide/slack).
 *
 * @module steps/slack
 * @packageDocumentation
 */

export { SlackApiError, type SlackParams } from "../../providers/slack.ts";
export { callSlack } from "./call.ts";
export { fetchSlackMessage } from "./fetch-message.ts";
export { postSlackMessage } from "./post-message.ts";
