// Which Slack thread belongs to which run, in the World's own Postgres beside
// the worktree registry. Its own table, not a column on that one: a worktree
// row is deleted at teardown and a run's thread outlives the run it belongs
// to. Like the registry it holds state, never config — the channel comes from
// jigs.yml, and what is recorded here is where one run's story was told.
//
// One thing it does not share with jigs_worktrees: that table holds live
// worktrees only, so a schema that has drifted is repaired by dropping it and
// letting start recreate it. This one holds the threads of runs still in
// flight, and dropping it silences every one of them. The first column added
// here needs a real migration, not a DROP TABLE in the repair text.

import type { ISql } from "postgres";

export interface SlackThreadRow {
  runId: string;
  channel: string;
  threadTs: string;
}

export async function ensureSlackThreads(sql: ISql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS jigs_slack_threads (
      run_id text PRIMARY KEY,
      channel text NOT NULL,
      thread_ts text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  // The reverse lookup is not the key: an operator can start two runs from one
  // thread, so a thread maps to many runs while a run maps to one thread. It
  // also runs on every Slack message this factory hears.
  await sql`
    CREATE INDEX IF NOT EXISTS jigs_slack_threads_by_thread
      ON jigs_slack_threads (channel, thread_ts, created_at DESC)
  `;
}

/** First mapping wins: a run has one thread for its whole life, so a repeated
 *  start of the same run must never move it. */
export async function insertSlackThread(
  sql: ISql,
  row: SlackThreadRow,
): Promise<void> {
  await sql`
    INSERT INTO jigs_slack_threads (run_id, channel, thread_ts)
    VALUES (${row.runId}, ${row.channel}, ${row.threadTs})
    ON CONFLICT (run_id) DO NOTHING
  `;
}

export async function getSlackThreadForRun(
  sql: ISql,
  runId: string,
): Promise<SlackThreadRow | null> {
  const rows = await sql<SlackThreadRow[]>`
    SELECT run_id, channel, thread_ts FROM jigs_slack_threads
    WHERE run_id = ${runId}
  `;
  return rows[0] ?? null;
}

/** The run a thread belongs to — the newest, when the operator started more
 *  than one from it, because that is the one they are still talking about. */
export async function getRunForSlackThread(
  sql: ISql,
  channel: string,
  threadTs: string,
): Promise<SlackThreadRow | null> {
  const rows = await sql<SlackThreadRow[]>`
    SELECT run_id, channel, thread_ts FROM jigs_slack_threads
    WHERE channel = ${channel} AND thread_ts = ${threadTs}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/** The threads of these runs. Takes the run ids rather than reading the whole
 *  table: what a restart needs to pick back up is the runs still in flight,
 *  and only the World knows which those are. */
export async function listSlackThreadsForRuns(
  sql: ISql,
  runIds: readonly string[],
): Promise<SlackThreadRow[]> {
  if (runIds.length === 0) return [];
  return sql<SlackThreadRow[]>`
    SELECT run_id, channel, thread_ts FROM jigs_slack_threads
    WHERE run_id = ANY(${runIds as string[]})
    ORDER BY created_at ASC
  `;
}
