import {
  type CursorRequest,
  cursorPath,
  type MessagesResponse,
  maxWaitSeconds,
  messagesPath,
} from "@jigs-ai/hub-protocol";
import express, { type Request, type Response, type Router } from "express";
import type { HubDatabase } from "./db/database.ts";
import { authenticateFactory, type Factory } from "./factories.ts";
import { confirmCursor, type MessageWaiters, readMessages } from "./messages.ts";

const MAX_POSITION = 2n ** 63n - 1n;

/** The routes a factory calls with its token: its messages and its cursor. */
export function createFactoryApi(db: HubDatabase, waiters: MessageWaiters): Router {
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

  return router;
}
