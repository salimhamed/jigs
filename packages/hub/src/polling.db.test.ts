import { eq } from "drizzle-orm";
import { beforeAll, expect, vi } from "vitest";
import { type App, assignApp, type Installation, recordInstallation } from "./apps.ts";
import * as schema from "./db/schema.ts";
import { dbTest } from "./db/test-database.ts";
import { readMessages } from "./messages.ts";
import { type Poller, pollInstallation } from "./polling.ts";
import { organizationId, setUpTestHub } from "./test-hub.ts";

const { db, waiters, newFactory } = setUpTestHub();
let app: App;
let installation: Installation;
let factoryId: string;

beforeAll(async () => {
  [app] = (await db
    .insert(schema.apps)
    .values({
      organizationId,
      provider: "linear",
      name: "Jigs",
      externalId: "client-1",
      settings: {},
      secrets: "",
    })
    .returning()) as [App];
  await recordInstallation(db, app, { externalId: "workspace-1", account: "acme" });
  [installation] = (await db
    .select()
    .from(schema.installations)
    .where(eq(schema.installations.appId, app.id))) as [Installation];
  factoryId = (await newFactory()).factory.id;
  await assignApp(db, organizationId, factoryId, app.id);
});

// Reports each session it is given as archived on every poll, and numbers its polls as markers.
const archivedSessions = (sessions: string[]) => {
  let polls = 0;
  return {
    name: "test-archived",
    provider: "linear",
    poll: vi.fn<Poller["poll"]>(async () => {
      polls += 1;
      return {
        events: sessions.map((id) => ({
          name: "AgentSessionEvent",
          payload: { type: "AgentSessionEvent", action: "dismissed", agentSession: { id } },
          dedupeKey: `dismissed:${id}`,
        })),
        marker: `poll ${polls}`,
      };
    }),
  } satisfies Poller;
};

dbTest("a poll sends what it made once, as the hub's, and keeps its marker", async () => {
  const poller = archivedSessions(["session-1"]);
  await pollInstallation(db, waiters, poller, app, installation);
  await pollInstallation(db, waiters, poller, app, installation);

  expect(poller.poll.mock.calls.map(([, , marker]) => marker)).toEqual([null, "poll 1"]);
  const events = (await readMessages(db, factoryId)).flatMap((message) =>
    message.kind === "event" ? [message.event] : [],
  );
  expect(events).toEqual([
    expect.objectContaining({
      provider: "linear",
      name: "AgentSessionEvent",
      origin: "hub",
      payload: expect.objectContaining({ agentSession: { id: "session-1" } }),
    }),
  ]);
  const [row] = await db
    .select()
    .from(schema.pollMarkers)
    .where(eq(schema.pollMarkers.poller, poller.name));
  expect(row?.marker).toBe("poll 2");
});

dbTest("an installation another hub is polling is passed over", async () => {
  const poller = archivedSessions([]);
  await pollInstallation(db, waiters, poller, app, installation);
  await db.transaction(async (tx) => {
    await tx
      .select()
      .from(schema.pollMarkers)
      .where(eq(schema.pollMarkers.poller, poller.name))
      .for("update");
    await pollInstallation(db, waiters, poller, app, installation);
  });
  expect(poller.poll).toHaveBeenCalledOnce();
});
