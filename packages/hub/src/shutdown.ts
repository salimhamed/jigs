import type { Server } from "node:http";
import type { RequestHandler, Response } from "express";

/**
 * Lets the hub stop while factories hold keep-alive connections. Once it is
 * stopping, every answer closes its connection, so a factory polling again at
 * once cannot keep a connection, and the server, open.
 */
export class Shutdown {
  #server: Server | undefined;
  readonly #answering = new Set<Response>();

  readonly gate: RequestHandler = (_request, response, next) => {
    if (this.#server) response.set("connection", "close");
    this.#answering.add(response);
    response.on("close", () => {
      this.#answering.delete(response);
      // A response that began before the stop kept its connection alive; it is idle only once this one ends.
      const server = this.#server;
      if (server) setImmediate(() => server.closeIdleConnections());
    });
    next();
  };

  /** Stop accepting connections and resolve once the requests in flight have answered and every connection has closed. */
  close(server: Server): Promise<void> {
    this.#server = server;
    for (const response of this.#answering)
      if (!response.headersSent) response.set("connection", "close");
    return new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeIdleConnections();
    });
  }
}
