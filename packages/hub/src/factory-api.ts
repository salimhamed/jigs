import {
  type CursorRequest,
  cursorPath,
  type MessagesResponse,
  maxWaitSeconds,
  messagesPath,
} from "@jigs-ai/hub-protocol";
import express, { type RequestHandler, type Router } from "express";
import type { HubDatabase } from "./db/database.ts";
import { authenticateFactory, type Factory } from "./factories.ts";
import { confirmCursor, type MessageWaiters, readMessages } from "./messages.ts";

const MAX_POSITION = 2n ** 63n - 1n;

/** The routes a factory calls with its token: its messages and its cursor. */
export function createFactoryApi(db: HubDatabase, waiters: MessageWaiters): Router {
  const router = express.Router();

  const authenticate: RequestHandler = async (request, response, next) => {
    const token = /^Bearer (\S+)$/i.exec(request.get("authorization") ?? "")?.[1];
    const factory = token ? await authenticateFactory(db, token, request.get("user-agent")) : null;
    if (!factory) {
      response.status(401).json({ error: "The hub does not know this factory token." });
      return;
    }
    response.locals.factory = factory;
    next();
  };

  router.get(messagesPath, authenticate, async (request, response) => {
    const factory: Factory = response.locals.factory;
    const wait = Math.min(Math.max(Number(request.query.wait) || 0, 0), maxWaitSeconds);
    const gone = new AbortController();
    response.on("close", () => gone.abort());
    // Wait before reading, so a message appended between the two still wakes it.
    const woken = wait > 0 ? waiters.wait(factory.id, wait * 1000, gone.signal) : null;
    let messages = await readMessages(db, factory.id);
    if (messages.length === 0 && woken) {
      await woken;
      if (gone.signal.aborted) return;
      messages = await readMessages(db, factory.id);
    }
    response.json({ messages } satisfies MessagesResponse);
  });

  router.post(cursorPath, authenticate, express.json(), async (request, response) => {
    const factory: Factory = response.locals.factory;
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

  return router;
}
