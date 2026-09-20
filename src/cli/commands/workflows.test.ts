import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { listWorkflows } from "./workflows.ts";

const fetchMock = vi.fn();
let lines: string[];

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  lines = [];
});

afterEach(() => vi.unstubAllGlobals());

const deps = () => ({
  out: (line: string) => lines.push(line),
  serviceUrl: "http://svc.test:8990",
});

test("lists registered launch names with existing schema guidance", async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        workflows: [
          {
            name: "ship",
            inputs: {
              type: "object",
              properties: {
                ticket: { type: "string", description: "Linear ticket\nto deliver" },
                attempts: { type: "number", default: 3 },
              },
              required: ["ticket"],
            },
          },
        ],
      }),
    ),
  );

  await listWorkflows(deps());

  expect(fetchMock).toHaveBeenCalledWith("http://svc.test:8990/api/workflows", undefined);
  expect(lines[0]).toBe("WORKFLOW  INPUTS");
  expect(lines[1]).toContain("ticket (string, required) — Linear ticket to deliver");
  expect(lines[1]).toContain("attempts (number, optional, default 3)");
});

test("an empty registry is explicit", async () => {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ workflows: [] })));
  await listWorkflows(deps());
  expect(lines).toEqual(["no workflows registered"]);
});

test("a service error is actionable", async () => {
  fetchMock.mockResolvedValueOnce(new Response("bundle unavailable", { status: 503 }));
  await expect(listWorkflows(deps())).rejects.toThrow(
    "workflows failed: HTTP 503 bundle unavailable",
  );
});
