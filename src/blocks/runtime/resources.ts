import { JigsError } from "../errors.ts";

/** A durable thing that a run created or otherwise owns a reference to. */
export interface RunResource {
  /** The resource category, such as `worktree` or `run-directory`. */
  kind: string;
  /** The stable name that distinguishes this resource from others of the same kind. */
  identity: string;
  /** An absolute URL where a human can inspect the resource. */
  url: string;
}

// One attribute per resource lets the World's atomic per-key merge preserve
// simultaneous registrations. The namespace is reserved because it is a jigs
// storage contract rather than factory-authored metadata.
export const RESOURCE_ATTRIBUTE_PREFIX = "$jigs.resource.v1:";
export const RUN_ATTRIBUTE_KEY_LIMIT = 256;
export const RUN_ATTRIBUTE_VALUE_BYTE_LIMIT = 256;
export const RUN_ATTRIBUTE_COUNT_LIMIT = 64;

const encoder = new TextEncoder();

const characters = (count: number): string =>
  `${count} ${count === 1 ? "character" : "characters"}`;
const bytes = (count: number): string => `${count} UTF-8 ${count === 1 ? "byte" : "bytes"}`;

function nonEmpty(value: string, field: "kind" | "identity" | "url"): void {
  if (value.length === 0) throw new JigsError(`resource ${field} must not be empty`);
  if (!value.isWellFormed()) {
    throw new JigsError(`resource ${field} must contain valid Unicode`);
  }
}

function encodedPart(value: string, field: "kind" | "identity"): string {
  nonEmpty(value, field);
  return encodeURIComponent(value);
}

/** The single SDK attribute write representing a resource. */
export function resourceAttribute(resource: RunResource): { key: string; value: string } {
  const kind = encodedPart(resource.kind, "kind");
  const identity = encodedPart(resource.identity, "identity");
  const key = `${RESOURCE_ATTRIBUTE_PREFIX}${kind}:${identity}`;
  if (key.length > RUN_ATTRIBUTE_KEY_LIMIT) {
    const componentBudget = RUN_ATTRIBUTE_KEY_LIMIT - RESOURCE_ATTRIBUTE_PREFIX.length - 1;
    const kindBytes = encoder.encode(resource.kind).length;
    const identityBytes = encoder.encode(resource.identity).length;
    const oversized =
      kind.length > componentBudget && identity.length > componentBudget
        ? "kind and identity are each too long"
        : kind.length > componentBudget
          ? "kind is too long"
          : identity.length > componentBudget
            ? "identity is too long"
            : "kind and identity are too long together";
    throw new JigsError(
      `resource ${oversized} to register: encoded kind uses ${characters(kind.length)} from ${bytes(kindBytes)} and encoded identity uses ${characters(identity.length)} from ${bytes(identityBytes)}; together they have a ${componentBudget}-character budget and produce a ${key.length}-character attribute key (limit ${RUN_ATTRIBUTE_KEY_LIMIT})`,
      `shorten the resource kind, identity, or both until their encoded lengths total at most ${componentBudget} characters; jigs never truncates either component`,
    );
  }

  nonEmpty(resource.url, "url");
  try {
    new URL(resource.url);
  } catch {
    throw new JigsError(`resource URL is not an absolute URL: ${JSON.stringify(resource.url)}`);
  }
  const urlBytes = encoder.encode(resource.url).length;
  if (urlBytes > RUN_ATTRIBUTE_VALUE_BYTE_LIMIT) {
    throw new JigsError(
      `resource URL is too long to register: ${urlBytes} UTF-8 bytes (limit ${RUN_ATTRIBUTE_VALUE_BYTE_LIMIT})`,
      "use a shorter URL; jigs never truncates resource URLs",
    );
  }
  return { key, value: resource.url };
}

function decodeResource(key: string, url: string): RunResource | null {
  if (!key.startsWith(RESOURCE_ATTRIBUTE_PREFIX)) return null;
  const encoded = key.slice(RESOURCE_ATTRIBUTE_PREFIX.length);
  const separator = encoded.indexOf(":");
  if (separator === -1) return null;
  try {
    const kind = decodeURIComponent(encoded.slice(0, separator));
    const identity = decodeURIComponent(encoded.slice(separator + 1));
    if (kind.length === 0 || identity.length === 0) return null;
    new URL(url);
    return { kind, identity, url };
  } catch {
    // A malformed value in jigs' reserved namespace must not make the run
    // itself uninspectable. Registration never writes one of these.
    return null;
  }
}

/** Decode the current resource set from a run's materialized attributes. */
export function resourcesFromAttributes(
  attributes: Readonly<Record<string, string>> | undefined,
): RunResource[] {
  if (attributes === undefined) return [];
  return Object.entries(attributes)
    .flatMap(([key, value]) => {
      const resource = decodeResource(key, value);
      return resource === null ? [] : [resource];
    })
    .sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) || left.identity.localeCompare(right.identity),
    );
}
