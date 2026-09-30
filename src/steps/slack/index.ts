/**
 * Low-level Slack operations for factory-owned steps. Workflow code calls their
 * `#jigs/steps` wrappers; waiting for a thread reply is `waitForSlackReply`
 * from `#jigs/routines`.
 *
 * See [Slack](https://salimhamed.github.io/jigs/guide/slack).
 *
 * @module steps/slack
 * @packageDocumentation
 */

export { fetchSlackMessage } from "./fetch-message.ts";
export { postSlackMessage } from "./post-message.ts";
