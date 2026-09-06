// The shared suspension record (ADR 0003): both primitives differ only in
// what satisfies them. Carried as hook metadata so GET /api/runs can surface
// why a run is parked; satisfiedBy is the hook token, i.e. the wake channel.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// Type aliases, not interfaces: aliases carry an implicit index signature,
// which is what makes the envelope assignable to the SDK's Serializable
// hook-metadata type.
export type SuspensionRecord = {
  key: string;
  reason: string;
  payload?: JsonValue;
  satisfiedBy: string;
};

type SuspensionEnvelope = {
  jigs: "suspension";
  record: SuspensionRecord;
};

// The two keys the ticket claim records itself under. The claim is held for a
// run's whole life and says nothing about the run being parked — the same
// thing `isParkToken` says about its token, for anything reading the records
// instead of the tokens.
export const CLAIM_KEY = "ticket-claim";
export const CLAIM_ALIAS_KEY = "ticket-claim-alias";
export const TICKET_CLAIM_KEYS: ReadonlySet<string> = new Set([
  CLAIM_KEY,
  CLAIM_ALIAS_KEY,
]);

export function suspensionMetadata(
  record: SuspensionRecord,
): SuspensionEnvelope {
  return { jigs: "suspension", record };
}

export function readSuspensionMetadata(
  metadata: unknown,
): SuspensionRecord | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const envelope = metadata as Partial<SuspensionEnvelope>;
  if (
    envelope.jigs !== "suspension" ||
    typeof envelope.record !== "object" ||
    envelope.record === null
  ) {
    return null;
  }
  const record = envelope.record as Partial<SuspensionRecord>;
  if (
    typeof record.key !== "string" ||
    typeof record.reason !== "string" ||
    typeof record.satisfiedBy !== "string"
  ) {
    return null;
  }
  return record as SuspensionRecord;
}
