import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { HubDatabase } from "./db/database.ts";
import { factories } from "./db/schema.ts";

export type Factory = typeof factories.$inferSelect;

// A token is 256 random bits, so an unsalted hash is as hard to reverse as the token is to guess.
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const newToken = () => {
  const token = randomBytes(32).toString("base64url");
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

/** Give a factory a new token; the old one stops working at once. `null` if no such factory. */
export async function reissueToken(
  db: HubDatabase,
  organizationId: string,
  factoryId: string,
): Promise<string | null> {
  const { token, tokenHash } = newToken();
  const updated = await db
    .update(factories)
    .set({ tokenHash })
    .where(and(eq(factories.id, factoryId), eq(factories.organizationId, organizationId)))
    .returning({ id: factories.id });
  return updated.length > 0 ? token : null;
}

/** Remove a factory and every message waiting for it. */
export async function removeFactory(
  db: HubDatabase,
  organizationId: string,
  factoryId: string,
): Promise<void> {
  await db
    .delete(factories)
    .where(and(eq(factories.id, factoryId), eq(factories.organizationId, organizationId)));
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
