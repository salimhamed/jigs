import { expect, test } from "vitest";
import { type ExecError, nodeExecFile } from "./exec.ts";

const script = (source: string) => [process.execPath, ["-e", source]] as const;

test("onLine sees each line of stdout and stderr as the child prints it, and still captures both", async () => {
  const lines: string[] = [];
  const [file, args] = script(
    "process.stdout.write('pulling\\n'); process.stderr.write('Container x  Healthy\\ndone')",
  );

  const result = await nodeExecFile(file, [...args], {
    cwd: process.cwd(),
    onLine: (line) => lines.push(line),
  });

  expect(lines.sort()).toEqual(["Container x  Healthy", "done", "pulling"]);
  expect(result.stdout).toBe("pulling\n");
  expect(result.stderr).toBe("Container x  Healthy\ndone");
});

test("a streamed child that fails rejects with its exit code and captured output", async () => {
  const [file, args] = script(
    "process.stderr.write('Cannot connect to the Docker daemon\\n'); process.exit(3)",
  );

  const failure = (await nodeExecFile(file, [...args], {
    cwd: process.cwd(),
    onLine: () => {},
  }).catch((err: unknown) => err)) as ExecError;

  expect(failure.code).toBe(3);
  expect(failure.stderr).toContain("Cannot connect to the Docker daemon");
});

test("a streamed binary that is not there rejects with ENOENT", async () => {
  const failure = (await nodeExecFile("jigs-no-such-binary", [], {
    cwd: process.cwd(),
    onLine: () => {},
  }).catch((err: unknown) => err)) as ExecError;

  expect(failure.code).toBe("ENOENT");
});
