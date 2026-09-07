import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CliError } from "../errors.ts";
import { pokeRun } from "./poke.ts";

const fetchMock = vi.fn();
let lines: string[];

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  lines = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const deps = () => ({
  out: (line: string) => lines.push(line),
  serviceUrl: "http://svc.test:8990",
});

test("poke posts to the run's poke route and prints the resumed tokens", async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        runId: "wr_abc",
        poked: [
          { token: "github:pr:acme/api#41", resumed: true },
          { token: "linear:ticket:uuid-1", resumed: false },
        ],
      }),
    ),
  );
  const result = await pokeRun("wr_abc", deps());
  expect(fetchMock).toHaveBeenCalledWith(
    "http://svc.test:8990/api/runs/wr_abc/poke",
    { method: "POST" },
  );
  expect(result.poked).toHaveLength(2);
  expect(lines).toEqual([
    "poked github:pr:acme/api#41",
    "gone (not poked): linear:ticket:uuid-1",
  ]);
});

test("a 404 becomes a CliError naming the run", async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
  );
  await expect(pokeRun("wr_missing", deps())).rejects.toThrow(
    "run wr_missing not found",
  );
});

test("a 409 becomes a CliError with an inspection hint", async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: "no suspensions" }), { status: 409 }),
  );
  const failure = await pokeRun("wr_done", deps()).then(
    () => null,
    (err: unknown) => err,
  );
  expect(failure).toBeInstanceOf(CliError);
  expect((failure as CliError).message).toBe("run has no suspensions to poke");
  expect((failure as CliError).hint).toContain("jigs logs wr_done");
});

test("a connection failure surfaces the shared unreachable error", async () => {
  fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
  const failure = await pokeRun("wr_abc", deps()).then(
    () => null,
    (err: unknown) => err,
  );
  expect(failure).toBeInstanceOf(CliError);
  expect((failure as CliError).message).toContain("http://svc.test:8990");
  expect((failure as CliError).hint).toContain("jigs service start");
});

test("a trailing slash on the service URL does not break the poke route", async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ runId: "wr_abc", poked: [] })),
  );
  await pokeRun("wr_abc", {
    out: (line: string) => lines.push(line),
    serviceUrl: "http://svc.test:8990/",
  });
  expect(fetchMock).toHaveBeenCalledWith(
    "http://svc.test:8990/api/runs/wr_abc/poke",
    { method: "POST" },
  );
});
