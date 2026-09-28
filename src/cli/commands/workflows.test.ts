import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { layoutProblems } from "../output-layout.ts";
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
  expect(lines).toEqual([
    "WORKFLOW  INPUTS",
    "ship      ticket (string, required): Linear ticket to deliver",
    "          attempts (number, optional, default 3)",
  ]);
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

// Every test's output, passing or failing, keeps to the shared layout.
afterEach(() => {
  expect(layoutProblems(lines)).toEqual([]);
});
