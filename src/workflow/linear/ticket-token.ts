// Apart from claim.ts, which imports the Workflow SDK, so the CLI can read a
// token without bundling it.
/** Prefix for the durable hook that gives one run exclusive ownership of a ticket. */
export const TICKET_TOKEN_PREFIX = "linear:ticket:";
