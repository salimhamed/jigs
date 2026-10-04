import {
  type CursorRequest,
  cursorPath,
  type FactoryStatus,
  factoryStatusPath,
  type GitHubTokenRequest,
  githubTokenPath,
  type MessagesResponse,
  maxWaitSeconds,
  messagesPath,
} from "@jigs-ai/hub-protocol";
import { asc, eq } from "drizzle-orm";
import express, { type Request, type Response, type Router } from "express";
import type { HubDatabase } from "./db/database.ts";
import { apps, assignments, installations, organization } from "./db/schema.ts";
import { authenticateFactory, type Factory } from "./factories.ts";
import type { GitHubTokens } from "./github.ts";
import { confirmCursor, type MessageWaiters, readMessages } from "./messages.ts";

const MAX_POSITION = 2n ** 63n - 1n;

/** The routes a factory calls with its token: its messages, cursor, status and provider tokens. */
export function createFactoryApi(options: {
  db: HubDatabase;
  waiters: MessageWaiters;
  githubTokens: GitHubTokens;
}): Router {
  const { db, waiters, githubTokens } = options;
  const router = express.Router();

  // The factory the request's token belongs to, or `null` once it has answered 401.
  const authenticate = async (request: Request, response: Response): Promise<Factory | null> => {
    const token = /^Bearer (\S+)$/i.exec(request.get("authorization") ?? "")?.[1];
    const factory = token ? await authenticateFactory(db, token, request.get("user-agent")) : null;
    if (!factory) response.status(401).json({ error: "The hub does not know this factory token." });
    return factory;
  };

  router.get(messagesPath, async (request, response) => {
    const gone = new AbortController();
    response.on("close", () => gone.abort());
    const factory = await authenticate(request, response);
    if (!factory) return;
    const wait = Math.min(Math.max(Number(request.query.wait) || 0, 0), maxWaitSeconds);
    // Wait before reading, so a message appended between the two still wakes it.
    const woken = wait > 0 ? waiters.wait(factory.id, wait * 1000, gone.signal) : null;
    let messages = await readMessages(db, factory.id);
    if (messages.length === 0 && woken) {
      await woken;
      if (gone.signal.aborted) return;
      // The token may have been re-issued or the factory removed while it waited.
      if (!(await authenticate(request, response))) return;
      messages = await readMessages(db, factory.id);
    }
    response.json({ messages } satisfies MessagesResponse);
  });

  router.post(cursorPath, express.json(), async (request, response) => {
    const factory = await authenticate(request, response);
    if (!factory) return;
    const { position } = (request.body ?? {}) as Partial<CursorRequest>;
    if (
      typeof position !== "string" ||
      !/^\d{1,19}$/.test(position) ||
      BigInt(position) > MAX_POSITION
    ) {
      response.status(400).json({ error: "position must be a message position." });
      return;
    }
    await confirmCursor(db, factory.id, BigInt(position));
    response.status(204).end();
  });

  router.get(factoryStatusPath, async (request, response) => {
    const factory = await authenticate(request, response);
    if (!factory) return;
    response.json((await readStatus(db, factory)) satisfies FactoryStatus);
  });

  router.post(githubTokenPath, express.json(), async (request, response) => {
    const factory = await authenticate(request, response);
    if (!factory) return;
    const { owner } = (request.body ?? {}) as Partial<GitHubTokenRequest>;
    if (typeof owner !== "string" || owner === "") {
      response.status(400).json({ error: "owner must be a GitHub login." });
      return;
    }
    const issued = await githubTokens.issue(factory.id, owner);
    if ("error" in issued) {
      response.status(issued.status).json({ error: issued.error });
      return;
    }
    response.json(issued.token);
  });

  return router;
}

async function readStatus(db: HubDatabase, factory: Factory): Promise<FactoryStatus> {
  const owner = await db.query.organization.findFirst({
    columns: { name: true },
    where: eq(organization.id, factory.organizationId),
  });
  const rows = await db
    .select({
      id: apps.id,
      provider: apps.provider,
      name: apps.name,
      account: installations.account,
    })
    .from(assignments)
    .innerJoin(apps, eq(apps.id, assignments.appId))
    .leftJoin(installations, eq(installations.appId, apps.id))
    .where(eq(assignments.factoryId, factory.id))
    .orderBy(asc(apps.name), asc(installations.account));
  const assigned = new Map<string, FactoryStatus["apps"][number]>();
  for (const row of rows) {
    let app = assigned.get(row.id);
    if (!app) {
      app = { provider: row.provider, name: row.name, installations: [] };
      assigned.set(row.id, app);
    }
    if (row.account !== null) app.installations.push({ account: row.account });
  }
  return {
    factory: { name: factory.name },
    organization: { name: owner?.name ?? "" },
    apps: [...assigned.values()],
  };
}
