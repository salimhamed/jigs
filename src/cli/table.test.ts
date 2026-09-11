import { expect, test } from "vitest";
import { formatTable } from "./table.ts";

test("columns are padded to the widest cell and the last column is not", () => {
  const lines = formatTable(
    ["RUN", "STATUS"],
    [
      ["01K3", "running"],
      ["01K3ANBZ", "suspended"],
    ],
  );
  expect(lines).toEqual([
    "RUN       STATUS",
    "01K3      running",
    "01K3ANBZ  suspended",
  ]);
});
