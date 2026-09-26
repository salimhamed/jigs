import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { runOperator } from "./mentions.ts";

afterEach(() => vi.unstubAllEnvs());

function factory(operator: string | undefined) {
  const root = mkdtempSync(path.join(tmpdir(), "jigs-mentions-"));
  vi.stubEnv("JIGS_FACTORY_ROOT", root);
  const linear =
    operator === undefined ? "" : `, linear: { operator: ${JSON.stringify(operator)} }`;
  writeFileSync(
    path.join(root, "jigs.config.ts"),
    `export default { service: { dashboardPort: 9000 }${linear} };`,
  );
  return root;
}

const entry = (id: string, linear?: { operator?: string }) => async () => ({
  default: {
    workflow: Object.assign(async () => {}, { workflowId: id }),
    inputs: z.object({}),
    ...(linear === undefined ? {} : { linear }),
  },
});

const definition = {
  service: { dashboardPort: 9000 },
  workflows: {
    plain: entry("compiled-plain"),
    own: entry("compiled-own", { operator: "dana@example.com" }),
  },
};

test("a workflow's own operator beats the factory's", async () => {
  const root = factory("salim@example.com");
  try {
    expect(
      await runOperator({ workflowRunId: "r", workflowName: "compiled-own" }, definition),
    ).toBe("dana@example.com");
    expect(
      await runOperator({ workflowRunId: "r", workflowName: "compiled-plain" }, definition),
    ).toBe("salim@example.com");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no operator anywhere reads as none", async () => {
  const root = factory(undefined);
  try {
    expect(
      await runOperator({ workflowRunId: "r", workflowName: "compiled-plain" }, definition),
    ).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run whose workflow is no longer in the factory warns and uses the factory's operator", async () => {
  const root = factory("salim@example.com");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(
      await runOperator({ workflowRunId: "r", workflowName: "compiled-renamed" }, definition),
    ).toBe("salim@example.com");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("compiled-renamed"));
  } finally {
    warn.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a workflow module that throws on import reads as an unknown operator, not a failure", async () => {
  const root = factory("salim@example.com");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const broken = {
      ...definition,
      workflows: {
        ...definition.workflows,
        broken: async () => {
          throw new Error("syntax error in broken.ts");
        },
      },
    };
    expect(
      await runOperator({ workflowRunId: "r", workflowName: "compiled-own" }, broken),
    ).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("syntax error in broken.ts"));
  } finally {
    warn.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable factory config reads as an unknown operator", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "jigs-mentions-"));
  vi.stubEnv("JIGS_FACTORY_ROOT", root);
  writeFileSync(path.join(root, "jigs.config.ts"), "export default { linear: { operator: 1 } };");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(
      await runOperator({ workflowRunId: "r", workflowName: "compiled-plain" }, definition),
    ).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("could not read the Linear operator"),
    );
  } finally {
    warn.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
