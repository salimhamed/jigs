import type { Server } from "node:http";
import type { RequestHandler, Response } from "express";

/**
 * Lets the hub stop while factories hold keep-alive connections. Once it is
 * stopping, every answer closes its connection and new requests get a 503, so a
 * factory polling again at once cannot keep a connection, and the server, open.
 */
export class Shutdown {
  #stopping = false;
  readonly #answering = new Set<Response>();

  readonly gate: RequestHandler = (_request, response, next) => {
    if (this.#stopping) {
      response.set("connection", "close").status(503).json({ error: "The hub is shutting down." });
      return;
    }
    this.#answering.add(response);
    response.on("close", () => this.#answering.delete(response));
    next();
  };

  /** Stop accepting requests and resolve once the ones in flight have answered and every connection has closed. */
  close(server: Server): Promise<void> {
    this.#stopping = true;
    for (const response of this.#answering)
      if (!response.headersSent) response.set("connection", "close");
    return new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeIdleConnections();
    });
  }
}
