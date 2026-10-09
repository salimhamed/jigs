import express, { type RequestHandler, type Response } from "express";

// GitHub sends at most 25 MB.
const raw = express.raw({ type: () => true, limit: "25mb" });

/** Keeps a webhook's body as the bytes its provider signed, an empty buffer when there are none. */
export const webhookBody: RequestHandler = (request, response, next) =>
  raw(request, response, (error) => {
    if (error) return next(error);
    if (!Buffer.isBuffer(request.body)) request.body = Buffer.alloc(0);
    next();
  });

/** A webhook body's JSON, or `undefined` once it has answered 400. */
export function parseWebhookJson<T>(body: Buffer, response: Response): T | undefined {
  try {
    return JSON.parse(body.toString("utf8")) as T;
  } catch {
    response.status(400).json({ error: "The body is not JSON." });
    return undefined;
  }
}
