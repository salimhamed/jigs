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
