import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { expect, test } from "vitest";
import { Shutdown } from "./shutdown.ts";

test("a response streaming when the stop began does not hold its keep-alive connection open", async () => {
  const shutdown = new Shutdown();
  let finish = () => {};
  const app = express()
    .use(shutdown.gate)
    .get("/stream", (_request, response) => {
      response.write("started");
      finish = () => response.end();
    });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  const response = await fetch(`http://127.0.0.1:${port}/stream`);
  const body = response.text();
  const started = Date.now();
  const closed = shutdown.close(server);
  finish();
  await body;
  await closed;
  expect(Date.now() - started).toBeLessThan(1000);
});
