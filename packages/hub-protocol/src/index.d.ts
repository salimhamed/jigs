/**
 * Messages the jigs hub and a factory exchange.
 *
 * @packageDocumentation
 */
/** Every kind of message on the hub connection. */
export declare const messageKinds: readonly ["event"];
/** One kind of message on the hub connection. */
export type MessageKind = (typeof messageKinds)[number];
