import {
  type CursorRequest,
  cursorPath,
  type FactoryStatus,
  factoryStatusPath,
  githubTokenPath,
  linearTokenPath,
  type MessagesResponse,
  maxWaitSeconds,
  messagesPath,
  pagerDutyTokenPath,
  slackTokenPath,
  type TokenRequest,
} from "@jigs-ai/hub-protocol";
import { eq } from "drizzle-orm";
import express, { type Request, type Response, type Router } from "express";
import { assignedApps } from "./apps.ts";
import type { HubDatabase } from "./db/database.ts";
import { organization } from "./db/schema.ts";
import { authenticateFactory, type Factory } from "./factories.ts";
import { issueGitHubToken } from "./github.ts";
import type { LinearTokens } from "./linear.ts";
import { confirmCursor, type MessageWaiters, readMessages } from "./messages.ts";
import { issuePagerDutyToken } from "./pagerduty.ts";
import { issueSlackToken } from "./slack.ts";

const MAX_POSITION = 2n ** 63n - 1n;

const answerToken = (
  response: Response,
  issued: { token: object } | { status: number; error: string },
) => {
  if ("error" in issued) response.status(issued.status).json({ error: issued.error });
  else response.json(issued.token);
};

/** The routes a factory calls with its token: its messages, cursor, status and provider tokens. */
export function createFactoryApi(options: {
  db: HubDatabase;
  waiters: MessageWaiters;
  encryptionKey: Buffer;
  linearTokens: LinearTokens;
  /** Providers' APIs, replaced in tests. */
  apiUrls?: { github?: string; pagerduty?: string };
}): Router {
  const { db, waiters, encryptionKey, linearTokens, apiUrls = {} } = options;
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
    // A factory that hung up gets no more queries, which shutdown may have closed the pool for.
    if (!factory || gone.signal.aborted) return;
    const wait = Math.min(Math.max(Number(request.query.wait) || 0, 0), maxWaitSeconds);
    // Wait before reading, so a message appended between the two still wakes it.
    const woken = wait > 0 ? waiters.wait(factory.id, wait * 1000, gone.signal) : null;
    let messages = await readMessages(db, factory.id);
    if (messages.length === 0 && woken) {
      await woken;
      if (gone.signal.aborted) return;
      // The token may have been re-issued or the factory removed while it waited.
      if (!(await authenticate(request, response)) || gone.signal.aborted) return;
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

  // The factory and the installation a token request names, or `null` once it has answered.
  const tokenRequest = async (request: Request, response: Response) => {
    const factory = await authenticate(request, response);
    if (!factory) return null;
    const { installationName } = (request.body ?? {}) as Partial<TokenRequest>;
    if (typeof installationName !== "string" || installationName === "") {
      response.status(400).json({ error: "installationName must name an installation." });
      return null;
    }
    return { factoryId: factory.id, installationName };
  };

  router.post(githubTokenPath, express.json(), async (request, response) => {
    const named = await tokenRequest(request, response);
    if (!named) return;
    answerToken(
      response,
      await issueGitHubToken(db, encryptionKey, named.factoryId, named.installationName, {
        apiUrl: apiUrls.github,
      }),
    );
  });

  router.post(linearTokenPath, express.json(), async (request, response) => {
    const named = await tokenRequest(request, response);
    if (!named) return;
    answerToken(response, await linearTokens.issue(named.factoryId, named.installationName));
  });

  router.post(slackTokenPath, express.json(), async (request, response) => {
    const named = await tokenRequest(request, response);
    if (!named) return;
    answerToken(
      response,
      await issueSlackToken(db, encryptionKey, named.factoryId, named.installationName),
    );
  });

  router.post(pagerDutyTokenPath, express.json(), async (request, response) => {
    const named = await tokenRequest(request, response);
    if (!named) return;
    answerToken(
      response,
      await issuePagerDutyToken(db, encryptionKey, named.factoryId, named.installationName, {
        apiUrl: apiUrls.pagerduty,
      }),
    );
  });

  return router;
}

async function readStatus(db: HubDatabase, factory: Factory): Promise<FactoryStatus> {
  const owner = await db.query.organization.findFirst({
    columns: { name: true },
    where: eq(organization.id, factory.organizationId),
  });
  return {
    factory: { name: factory.name },
    organization: { name: owner?.name ?? "" },
    apps: (await assignedApps(db, factory.id)).map(({ id: _, ...app }) => app),
  };
}
