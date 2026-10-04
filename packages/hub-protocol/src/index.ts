/**
 * Messages the jigs hub and a factory exchange.
 *
 * @packageDocumentation
 */

/** Every kind of message on the hub connection. */
export const messageKinds = ["event"] as const;

/** One kind of message on the hub connection. */
export type MessageKind = (typeof messageKinds)[number];
