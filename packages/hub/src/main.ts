import type { AddressInfo } from "node:net";
import { createHubServer } from "./server.ts";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

const server = createHubServer();
server.listen(port, host, () => {
  const address = server.address() as AddressInfo;
  console.log(`hub listening on http://${address.address}:${address.port}`);
});

process.once("SIGTERM", () => {
  server.close((error) => process.exit(error ? 1 : 0));
  server.closeIdleConnections();
});
