import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  Agent,
  type Dispatcher,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";
import { afterEach, expect, test } from "vitest";
import {
  describeStepCeiling,
  matchesSelfOrigin,
  raiseStepCeiling,
  SelfOriginDispatcher,
  selfOrigins,
} from "./step-ceiling.ts";

const restore = getGlobalDispatcher();
afterEach(() => {
  setGlobalDispatcher(restore);
});

test("the ceiling is scoped to the origin the World self-invokes on", () => {
  expect(selfOrigins({ PORT: "8990" })).toEqual([
    "http://localhost:8990",
    "http://127.0.0.1:8990",
    "http://[::1]:8990",
  ]);
  // WORKFLOW_LOCAL_BASE_URL is what world-postgres reads first.
  expect(
    selfOrigins({ PORT: "8990", WORKFLOW_LOCAL_BASE_URL: "http://svc:3000/x" }),
  ).toEqual(["http://svc:3000"]);
  expect(selfOrigins({})).toEqual([]);
});

test("raising the ceiling is what puts the router in front of global fetch", () => {
  raiseStepCeiling({ PORT: "8990" });
  expect(getGlobalDispatcher()).toBeInstanceOf(SelfOriginDispatcher);
});

test("only the self origin matches; everything jigs calls out to does not", () => {
  const origins = selfOrigins({ PORT: "8990" });
  expect(matchesSelfOrigin("http://localhost:8990", origins)).toBe(true);
  expect(matchesSelfOrigin("http://127.0.0.1:8990", origins)).toBe(true);
  expect(matchesSelfOrigin("https://api.github.com", origins)).toBe(false);
  // A different service on the same box is not this one.
  expect(matchesSelfOrigin("http://localhost:5432", origins)).toBe(false);
});

test("with no origin to resolve, loopback is the match and nothing else is", () => {
  expect(matchesSelfOrigin("http://localhost:1234", [])).toBe(true);
  expect(matchesSelfOrigin("http://127.0.0.1:1234", [])).toBe(true);
  expect(matchesSelfOrigin("https://api.linear.app", [])).toBe(false);
  expect(matchesSelfOrigin("not a url", [])).toBe(false);
});

test("the startup line names the scope and what is left alone", () => {
  expect(describeStepCeiling({ PORT: "8990" })).toBe(
    "uncapped on the step route at http://localhost:8990; undici defaults elsewhere",
  );
  expect(describeStepCeiling({})).toBe(
    "uncapped on the step route at any loopback origin; undici defaults elsewhere",
  );
});

test("a request off the self origin is handed to the dispatcher that was global", () => {
  const dispatched: string[] = [];
  const stub = (name: string) =>
    ({
      dispatch: (options: Dispatcher.DispatchOptions) => {
        dispatched.push(`${name} ${String(options.origin)}${options.path}`);
        return true;
      },
    }) as unknown as Dispatcher;
  const router = new SelfOriginDispatcher(
    ["http://localhost:8990"],
    stub("step"),
    stub("default"),
  );
  const handler = {} as Dispatcher.DispatchHandler;

  router.dispatch(
    {
      origin: "http://localhost:8990",
      path: "/.well-known/workflow/v1/step",
      method: "POST",
    },
    handler,
  );
  router.dispatch(
    { origin: "https://api.github.com", path: "/user", method: "GET" },
    handler,
  );

  expect(dispatched).toEqual([
    "step http://localhost:8990/.well-known/workflow/v1/step",
    "default https://api.github.com/user",
  ]);
});

test("the routing is what the process's own fetch picks up", async () => {
  const server = createServer((_req, res) => {
    // Past undici's ~1s timer granularity, so the agent that has a headers
    // timeout gives up and the one that has none does not.
    setTimeout(() => {
      res.writeHead(200);
      res.end("ok");
    }, 1300);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;

  const stepRoute = new Agent({ headersTimeout: 0 });
  const everythingElse = new Agent({ headersTimeout: 1 });
  setGlobalDispatcher(
    new SelfOriginDispatcher(
      [`http://localhost:${port}`],
      stepRoute,
      everythingElse,
    ),
  );

  const [self, other] = await Promise.allSettled([
    fetch(`http://localhost:${port}/.well-known/workflow/v1/step`),
    fetch(`http://127.0.0.1:${port}/anything-else`),
  ]);
  // Same server, same slow response: only the scope decides.
  expect(self.status).toBe("fulfilled");
  expect(other.status).toBe("rejected");

  await stepRoute.close();
  await everythingElse.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
