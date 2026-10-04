import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { Client } from "pg";
import { test } from "vitest";

// The container the repo root's compose.yaml brings up.
const adminUrl = new URL(
  process.env.WORKFLOW_POSTGRES_URL || "postgres://jigs:jigs@localhost:5439/jigs",
);

const reachable = () =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host: adminUrl.hostname, port: Number(adminUrl.port || 5432) });
    socket.setTimeout(1000);
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });

// A URL someone set is one they expect to work, so it fails rather than skips.
const withoutPostgres = !process.env.WORKFLOW_POSTGRES_URL && !(await reachable());

/** `test`, skipped when no URL is set and nothing listens on the compose container. */
export const dbTest = test.skipIf(withoutPostgres);

/** Create an empty database; `drop` removes it once its clients have gone. */
export async function createTestDatabase(): Promise<{ url: string; drop(): Promise<void> }> {
  const name = `hub_test_${randomUUID().replaceAll("-", "")}`;
  await withAdmin((admin) => admin.query(`CREATE DATABASE "${name}"`));
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    url: url.href,
    drop: () =>
      withAdmin(async (admin) => {
        const deadline = Date.now() + 8_000;
        for (;;) {
          const { rows } = await admin.query(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1",
            [name],
          );
          if (rows[0]?.count === 0) break;
          if (Date.now() >= deadline) throw new Error(`${name} still has clients connected`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await admin.query(`DROP DATABASE "${name}"`);
      }),
  };
}

async function withAdmin<T>(action: (admin: Client) => Promise<T>): Promise<T> {
  const admin = new Client({ connectionString: adminUrl.href });
  await admin.connect();
  try {
    return await action(admin);
  } finally {
    await admin.end();
  }
}
