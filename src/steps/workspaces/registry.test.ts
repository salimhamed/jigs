import { expect, test, vi } from "vitest";
import { connectRegistry } from "./registry.ts";

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
