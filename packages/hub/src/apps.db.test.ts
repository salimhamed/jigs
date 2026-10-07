import type { Provider } from "@jigs-ai/hub-protocol";
import { eq } from "drizzle-orm";
import { expect } from "vitest";
import { assignApp, assignedApps, renameApp, unassignApp } from "./apps.ts";
import * as schema from "./db/schema.ts";
import { dbTest } from "./db/test-database.ts";
import { addFactory } from "./factories.ts";
import { organizationId, setUpTestHub } from "./test-hub.ts";

const { db, newFactory } = setUpTestHub();

let apps = 0;
async function newApp(provider: Provider = "slack", organization = organizationId) {
  apps += 1;
  const [app] = await db
    .insert(schema.apps)
    .values({
      organizationId: organization,
      provider,
      name: `app ${apps}`,
      externalId: String(apps),
      settings: { slug: `app-${apps}` },
      secrets: "",
    })
    .returning();
  if (!app) throw new Error("expected an app");
  return app;
}

dbTest("renames an app of the Organization, keeping its settings", async () => {
  const app = await newApp("github");
  const theirs = await newApp("linear", "other");

  expect(await renameApp(db, organizationId, app.id, "Acme bot")).toEqual({ name: "Acme bot" });
  expect(await renameApp(db, organizationId, app.id, "")).toEqual({ error: "Name the app." });
  expect(await renameApp(db, organizationId, theirs.id, "Mine")).toEqual({
    error: "There is no such app.",
  });

  const stored = await db.query.apps.findFirst({ where: eq(schema.apps.id, app.id) });
  expect(stored).toMatchObject({ name: "Acme bot", settings: app.settings });
  const untouched = await db.query.apps.findFirst({ where: eq(schema.apps.id, theirs.id) });
  expect(untouched?.name).toBe(theirs.name);
});

dbTest("assigns and unassigns apps from a factory, only within its Organization", async () => {
  const [linear, slack, theirs] = [
    await newApp("linear"),
    await newApp("slack"),
    await newApp("slack", "other"),
  ];
  const { factory } = await newFactory();
  const foreign = await addFactory(db, "other", "theirs");
  const names = async (factoryId: string) =>
    (await assignedApps(db, factoryId)).map((app) => app.name);

  await assignApp(db, organizationId, factory.id, slack.id);
  await assignApp(db, organizationId, factory.id, linear.id);
  await assignApp(db, organizationId, factory.id, linear.id);
  await assignApp(db, organizationId, factory.id, theirs.id);
  await assignApp(db, organizationId, foreign.factory.id, slack.id);
  expect(await names(factory.id)).toEqual([linear.name, slack.name]);
  expect(await names(foreign.factory.id)).toEqual([]);

  await assignApp(db, "other", foreign.factory.id, theirs.id);
  await unassignApp(db, organizationId, foreign.factory.id, theirs.id);
  expect(await names(foreign.factory.id)).toEqual([theirs.name]);

  await unassignApp(db, organizationId, factory.id, linear.id);
  expect(await names(factory.id)).toEqual([slack.name]);
});
