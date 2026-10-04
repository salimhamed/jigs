import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { expect, test, vi } from "vitest";
import { connectRegistry, listResources, type RegistrySql } from "./registry.ts";

test("an idle pool error is reported without throwing out of the event emitter", async () => {
  // Pool construction is lazy: this test opens no database connection.
  const db = connectRegistry("postgres://localhost/unused");
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(() => db.$client.emit("error", new Error("connection lost"))).not.toThrow();
    expect(report).toHaveBeenCalledWith(
      "[registry] idle PostgreSQL connection failed: connection lost",
    );
  } finally {
    report.mockRestore();
    await db.$client.end();
  }
});

test("many run IDs are one array parameter, never one parameter each", async () => {
  const seen: unknown[][] = [];
  const pool = {
    async query(_config: unknown, values: unknown[]) {
      seen.push(values);
      return { rows: [] };
    },
  };
  const db = drizzle(pool as unknown as Pool) as unknown as RegistrySql;
  const runIds = Array.from({ length: 70_000 }, (_, index) => `wrun_${index}`);

  await listResources(db, { factory: "factory-a", runIds });
  await listResources(db, { factory: "factory-a", runIds: [] });

  expect(seen).toEqual([
    ["factory-a", runIds],
    ["factory-a", []],
  ]);
});
