import { expect } from "vitest";
import { dbTest } from "./db/test-database.ts";
import { addFactory, renameFactory } from "./factories.ts";
import { organizationId, setUpTestHub } from "./test-hub.ts";

const { db } = setUpTestHub();

dbTest("renames a factory, keeping names unique within the Organization", async () => {
  const { factory } = await addFactory(db, organizationId, "laptop", null);
  await addFactory(db, organizationId, "ci", null);
  await addFactory(db, "other", "workstation", null);

  expect(await renameFactory(db, organizationId, factory.id, "workstation")).toEqual({
    name: "workstation",
  });
  expect(await renameFactory(db, organizationId, factory.id, "ci")).toEqual({
    error: "A factory is already named ci.",
  });
  expect(await renameFactory(db, organizationId, factory.id, "")).toEqual({
    error: "Name the factory.",
  });
  expect(await renameFactory(db, "other", factory.id, "stolen")).toEqual({
    error: "There is no such factory.",
  });
  const stored = await db.query.factories.findFirst({
    where: (factories, { eq }) => eq(factories.id, factory.id),
  });
  expect(stored?.name).toBe("workstation");
});
