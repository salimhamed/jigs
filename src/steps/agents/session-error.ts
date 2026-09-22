/** A durable agent session is missing or cannot be resumed by this harness. */
export class AgentSessionError extends Error {
  override readonly name = "AgentSessionError";
}
