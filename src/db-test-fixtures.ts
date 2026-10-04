import { connect } from "node:net";
import { test } from "vitest";

// The container test/docker-compose.yml brings up, never a factory's World.
const FALLBACK_URL = "postgres://jigs:jigs@localhost:5439/jigs";

/** The server the db tests create their own databases on. */
export const postgresAdminUrl = new URL(process.env.WORKFLOW_POSTGRES_URL || FALLBACK_URL);

/** The admin URL pointed at another database on the same server. */
export function databaseUrl(database: string): URL {
  const url = new URL(postgresAdminUrl);
  url.pathname = `/${database}`;
  return url;
}

/**
 * Drop a suite's database once its clients have gone. A forced drop kills a
 * client whose pool already ended but whose socket PostgreSQL still counts,
 * and that client's error then lands in the next test file.
 */
export async function dropDatabaseOnceIdle(
  admin: { query: (text: string, values?: unknown[]) => Promise<{ rows: { count: number }[] }> },
  database: string,
): Promise<void> {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const { rows } = await admin.query(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1",
      [database],
    );
    if (rows[0]?.count === 0) break;
    if (Date.now() >= deadline) throw new Error(`${database} still has clients connected`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await admin.query(`DROP DATABASE "${database}"`);
}

const reachable = (url: URL) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host: url.hostname, port: Number(url.port || 5432), timeout: 1000 });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });

// A URL someone set is one they expect to work, so it fails rather than skips.
const withoutPostgres = !process.env.WORKFLOW_POSTGRES_URL && !(await reachable(postgresAdminUrl));

/** `test`, skipped when no URL is set and nothing listens on the fallback. */
export const dbTest = test.skipIf(withoutPostgres);
