import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { jigsDataDir } from "../../config/factory-context.ts";
import { JigsError } from "../../errors.ts";
import {
  judgeRecord,
  type ProcessControl,
  type ProcessEntry,
  parsePs,
} from "../../service/process-tree.ts";

// Supervision is one record under the jigs data dir, keyed by factory slug.
// The service leads its own process group, so the group finds what it started
// even after a parent in between has exited; the record's boot ID, start time
// and command tell the service apart from a later process that got the same
// pid.

const serviceRunSchema = z.object({
  /** Where this run's output starts in the shared log. */
  logOffset: z.number().int().nonnegative(),
  deathDetectedAt: z.string().optional(),
  signal: z.string().optional(),
});

const supervisionRecordSchema = z.object({
  process: z
    .object({
      /** The service's pid, which is also its process group ID. */
      processGroup: z.number().int().positive(),
      bootId: z.string(),
      startTime: z.string(),
      command: z.string(),
      /**
       * Set when the process is known to have exited during boot: a live
       * process at its pid is then someone else's, not one to refuse over.
       */
      exited: z.literal(true).optional(),
      /** Which bundle the process was started from. */
      bundle: z.string().optional(),
    })
    .optional(),
  run: serviceRunSchema.optional(),
});

/**
 * Everything jigs keeps about a factory's service. The process fields are
 * absent once nothing it started can be running; what the last run left
 * behind (its log offset, and when its death was noticed) outlives them, for
 * `jigs service status`.
 */
export type SupervisionRecord = z.infer<typeof supervisionRecordSchema>;

export type ServiceRun = z.infer<typeof serviceRunSchema>;

export function serviceLogPath(slug: string): string {
  return path.join(jigsDataDir(), "services", `${slug}.log`);
}

export function serviceRecordPath(slug: string): string {
  return path.join(jigsDataDir(), "services", `${slug}.supervision`);
}

export function serviceExclusionPath(slug: string): string {
  return path.join(jigsDataDir(), "services", `${slug}.maintenance-lock`);
}

export function readServiceRecord(slug: string): SupervisionRecord {
  const file = serviceRecordPath(slug);
  if (!existsSync(file)) return {};
  const record = parseRecord(readFileSync(file, "utf8"));
  if (record === undefined) {
    throw new JigsError(
      `the service record at ${file} is unreadable`,
      `check that nothing this factory's service started is still running, then delete the record: \`rm ${file}\``,
    );
  }
  return record;
}

export function writeServiceRecord(slug: string, record: SupervisionRecord): void {
  const file = serviceRecordPath(slug);
  if (record.process === undefined && record.run === undefined) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record)}\n`);
}

/** Drop the process from the record, keeping what status reports about its last run. */
export function forgetServiceProcess(slug: string): void {
  const { run } = readServiceRecord(slug);
  writeServiceRecord(slug, { run });
}

function parseRecord(text: string): SupervisionRecord | undefined {
  try {
    return supervisionRecordSchema.parse(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * The service as its record and the running processes describe it.
 *
 * - `none`: nothing recorded, or a record from before the machine last
 *   restarted, whose process is forgotten.
 * - `running`: the recorded service is running.
 * - `stopped`: the service has exited. `orphanGroup` is its process group
 *   while processes it started could still be in it.
 */
export type ServiceState =
  | { kind: "none" }
  | { kind: "running"; pid: number; processGroup: number }
  | { kind: "stopped"; orphanGroup: number | undefined };

// Throws rather than guess when the record names a live process it cannot
// vouch for: stopping it could kill someone else's process, and ignoring it
// could start a second service. Only commands that stop, start or prune pass
// `cleanUp`, which forgets a process from before the machine restarted.
export function inspectService(
  slug: string,
  processes: ProcessControl,
  { cleanUp }: { cleanUp: boolean },
): ServiceState {
  const recordFile = serviceRecordPath(slug);
  const recorded = readServiceRecord(slug).process;
  if (recorded === undefined) return { kind: "none" };
  const vouched = recorded.exited !== true;
  const unverified = (entry: ProcessEntry, why: string) =>
    new JigsError(
      `pid ${entry.pid} in ${recordFile} cannot be verified as the ${slug} service: ${entry.command}`,
      `${why}\nif that process is this factory's service, stop it yourself\nif it is not, delete the record: \`rm ${recordFile}\``,
    );

  const verdict = judgeRecord(recorded, {
    bootId: processes.bootId(),
    entries: parsePs(processes.snapshot()),
    startTime: (leader) => processes.startTime(leader),
  });
  switch (verdict.kind) {
    case "previous-boot":
      if (verdict.lookalike !== undefined && vouched) {
        throw unverified(
          verdict.lookalike,
          "the service record is from an earlier boot, yet this process matches its start time and command",
        );
      }
      if (cleanUp) forgetServiceProcess(slug);
      return { kind: "none" };
    case "service":
      return { kind: "running", pid: verdict.leader.pid, processGroup: recorded.processGroup };
    case "leader-gone":
      return { kind: "stopped", orphanGroup: recorded.processGroup };
    case "reused":
      if (vouched) {
        throw unverified(
          verdict.leader,
          "its start time or command differs from the service record",
        );
      }
      return { kind: "stopped", orphanGroup: undefined };
  }
}

export function livePid(slug: string, processes: ProcessControl): number | undefined {
  const state = inspectService(slug, processes, { cleanUp: false });
  return state.kind === "running" ? state.pid : undefined;
}

/**
 * Excludes service startup from offline resource maintenance. The directory
 * creation is the cross-process compare-and-set; a crashed holder is left in
 * place deliberately because guessing that a maintenance pass is gone would
 * reopen the startup/removal race.
 */
export function acquireServiceExclusion(
  slug: string,
  purpose: "start" | "resources-prune",
): () => void {
  const lock = serviceExclusionPath(slug);
  mkdirSync(path.dirname(lock), { recursive: true });
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new JigsError(
        `factory maintenance exclusion is already held at ${lock}`,
        "wait for the other command to finish\nif it crashed, inspect that directory before removing it",
      );
    }
    throw error;
  }
  writeFileSync(
    path.join(lock, "owner.json"),
    `${JSON.stringify({ pid: process.pid, purpose })}\n`,
  );
  return () => rmSync(lock, { recursive: true, force: true });
}
