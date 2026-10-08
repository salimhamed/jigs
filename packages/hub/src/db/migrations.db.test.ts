import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, expect } from "vitest";
import { packageRoot } from "../package-root.ts";
import { connectDatabase, migrateDatabase } from "./database.ts";
import * as schema from "./schema.ts";
import { dbTest, testDatabase } from "./test-database.ts";

const database = testDatabase();
const db = connectDatabase(database.url);

beforeAll(() => database.create());

afterAll(async () => {
  await db.$client.end();
  await database.drop();
});

/** A copy of the migrations folder that stops before the migration tagged `tag`. */
async function migrationsBefore(tag: string) {
  const folder = await mkdtemp(join(tmpdir(), "hub-migrations-"));
  await cp(fileURLToPath(new URL("migrations/", packageRoot)), folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  const index = journal.entries.findIndex((entry: { tag: string }) => entry.tag === tag);
  journal.entries = journal.entries.slice(0, index);
  await writeFile(journalPath, JSON.stringify(journal));
  return folder;
}

dbTest("moves each GitHub App's slug from its name into its settings", async () => {
  const folder = await migrationsBefore("0002_github_app_slug");
  try {
    await migrate(db, { migrationsFolder: folder });
  } finally {
    await rm(folder, { recursive: true });
  }
  await db
    .insert(schema.organization)
    .values({ id: "acme", name: "Acme", slug: "acme", createdAt: new Date() });
  const app = (provider: "github" | "slack", name: string, settings: object) => ({
    organizationId: "acme",
    provider,
    name,
    externalId: name,
    settings,
    secrets: "",
  });
  await db
    .insert(schema.apps)
    .values([
      app("github", "acme-jigs", { clientId: "Iv1.a", botUserId: 7 }),
      app("slack", "Acme bot", { clientId: "1.2", scopes: [] }),
    ]);

  await migrateDatabase(db);

  const settingsOf = async (name: string) =>
    (await db.query.apps.findFirst({ where: eq(schema.apps.name, name) }))?.settings;
  expect(await settingsOf("acme-jigs")).toEqual({
    slug: "acme-jigs",
    clientId: "Iv1.a",
    botUserId: 7,
  });
  expect(await settingsOf("Acme bot")).toEqual({ clientId: "1.2", scopes: [] });
});
