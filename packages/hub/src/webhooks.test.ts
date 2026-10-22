import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { brotliCompressSync } from "node:zlib";
import express from "express";
import { afterAll, beforeAll, expect, test } from "vitest";
import { webhookBody } from "./webhooks.ts";

let url: string;
let server: ReturnType<express.Express["listen"]>;

beforeAll(async () => {
  server = express()
    .post("/hook", webhookBody, (request, response) => {
      response.send(request.body);
    })
    .listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
});

afterAll(() => {
  server.close();
});

test("keeps a webhook's bytes as sent", async () => {
  const response = await fetch(url, { method: "POST", body: '{"a":1}' });
  expect(await response.text()).toBe('{"a":1}');
});

test("refuses a compressed webhook without decompressing it", async () => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-encoding": "br" },
    body: brotliCompressSync('{"a":1}'),
  });
  expect(response.status).toBe(415);
});
