import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type HubDatabase, isUniqueViolation } from "./db/database.ts";
import { factories } from "./db/schema.ts";
import type { MessageWaiters } from "./messages.ts";

export type Factory = typeof factories.$inferSelect;

// A token is 256 random bits, so an unsalted hash is as hard to reverse as the token is to guess.
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

// Hex, so a token never starts with "-" and reads as an option on the command line.
const newToken = () => {
  const token = randomBytes(32).toString("hex");
  return { token, tokenHash: hashToken(token) };
};

/** Add a factory to an Organization. The token is returned here only; the hub keeps its hash. */
export async function addFactory(
  db: HubDatabase,
  organizationId: string,
  name: string,
): Promise<{ factory: Factory; token: string }> {
  const { token, tokenHash } = newToken();
  const [factory] = await db
    .insert(factories)
    .values({ organizationId, name, tokenHash })
    .returning();
  if (!factory) throw new Error("adding a factory returned no row");
  return { factory, token };
}

/** Rename a factory. Names are unique within the Organization. */
export async function renameFactory(
  db: HubDatabase,
  organizationId: string,
  factoryId: string,
  name: string,
): Promise<{ name: string } | { error: string }> {
  if (!name) return { error: "Name the factory." };
  const renamed = await db
    .update(factories)
    .set({ name })
    .where(and(eq(factories.id, factoryId), eq(factories.organizationId, organizationId)))
    .returning({ id: factories.id })
    .catch((error: unknown) => {
      if (isUniqueViolation(error)) return null;
      throw error;
    });
  if (renamed === null) return { error: `A factory is already named ${name}.` };
  if (renamed.length === 0) return { error: "There is no such factory." };
  return { name };
}

/**
 * Give a factory a new token, or `null` if there is no such factory. The hub
 * refuses the old token from then on, and wakes its open polls so they are
 * refused too.
 */
export async function reissueToken(
  db: HubDatabase,
  waiters: MessageWaiters,
  organizationId: string,
  factoryId: string,
): Promise<string | null> {
  const { token, tokenHash } = newToken();
  const updated = await db
    .update(factories)
    .set({ tokenHash })
    .where(and(eq(factories.id, factoryId), eq(factories.organizationId, organizationId)))
    .returning({ id: factories.id });
  if (updated.length === 0) return null;
  waiters.wake([factoryId]);
  return token;
}

/** Remove a factory and every message waiting for it, and refuse its open polls. */
export async function removeFactory(
  db: HubDatabase,
  waiters: MessageWaiters,
  organizationId: string,
  factoryId: string,
): Promise<void> {
  await db
    .delete(factories)
    .where(and(eq(factories.id, factoryId), eq(factories.organizationId, organizationId)));
  waiters.wake([factoryId]);
}

/**
 * The factory a token belongs to, noting that it was seen and which jigs it
 * runs; `null` for an unknown token.
 */
export async function authenticateFactory(
  db: HubDatabase,
  token: string,
  userAgent: string | undefined,
): Promise<Factory | null> {
  const [factory] = await db
    .update(factories)
    .set({
      lastSeenAt: new Date(),
      lastSeenVersion: /^jigs\/(\S+)/.exec(userAgent ?? "")?.[1] ?? null,
    })
    .where(eq(factories.tokenHash, hashToken(token)))
    .returning();
  return factory ?? null;
}
