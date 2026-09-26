import type { ResourceFilter, ResourceKey, ResourceRow } from "./registry.ts";

/** The rows behind {@link memoryRegistry}; tests read and seed them directly. */
export const memoryRows: ResourceRow[] = [];

/** Runs just after a run's lock is taken, so a test can change the world under it. */
export const memoryLock: { taken?: (runId: string) => void } = {};

const same = (row: ResourceRow, key: ResourceKey) =>
  row.factory === key.factory &&
  row.runId === key.runId &&
  row.kind === key.kind &&
  row.identity === key.identity;

/**
 * The registry module's row operations over {@link memoryRows}, for `vi.mock`:
 * `vi.mock("./registry.ts", async (original) => ({ ...(await original()), ...memoryRegistry() }))`.
 */
export function memoryRegistry() {
  return {
    registrySql: () => ({}),
    currentFactory: () => "factory-a",
    withRunResourceLock: <T>(db: never, runId: string, action: (db: never) => Promise<T>) => {
      memoryLock.taken?.(runId);
      return action(db);
    },
    alsoLockRun: async () => undefined,
    listResources: async (_db: unknown, filter: ResourceFilter) =>
      memoryRows
        .filter(
          (row) =>
            row.factory === filter.factory &&
            (filter.runId === undefined || row.runId === filter.runId) &&
            (filter.kind === undefined || row.kind === filter.kind) &&
            (filter.identity === undefined || row.identity === filter.identity) &&
            (filter.states === undefined || filter.states.includes(row.state)),
        )
        .map((row) => ({ ...row })),
    recordResource: async (
      _db: unknown,
      row: ResourceKey & Pick<ResourceRow, "url"> & Partial<ResourceRow>,
    ) => {
      const existing = memoryRows.find((candidate) => same(candidate, row));
      const now = new Date();
      const refreshed = {
        url: row.url,
        state: "live" as const,
        reason: null,
        attempts: 0,
        updatedAt: now,
      };
      if (existing === undefined) {
        memoryRows.push({ repoDir: null, branch: null, createdAt: now, ...row, ...refreshed });
      } else {
        Object.assign(existing, refreshed, {
          ...(row.repoDir === undefined ? {} : { repoDir: row.repoDir }),
          ...(row.branch === undefined ? {} : { branch: row.branch }),
        });
      }
    },
    setResourceState: async (
      _db: unknown,
      key: ResourceKey,
      state: ResourceRow["state"],
      reason: string | null,
      attempts?: number,
    ) => {
      const row = memoryRows.find((candidate) => same(candidate, key));
      if (row === undefined) return;
      Object.assign(
        row,
        { state, reason, updatedAt: new Date() },
        attempts === undefined ? {} : { attempts },
      );
    },
  };
}
