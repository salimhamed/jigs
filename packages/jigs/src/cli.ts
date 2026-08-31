#!/usr/bin/env node
import readline from "node:readline/promises";
import { Command, Option } from "commander";
import { bindRepo } from "./commands/bind.ts";
import { type BindingRow, listBindings } from "./commands/bindings.ts";
import { buildFactoryService } from "./commands/build.ts";
import { cancelRun } from "./commands/cancel.ts";
import { runDoctor } from "./commands/doctor.ts";
import { initFactory } from "./commands/init.ts";
import { showLogs } from "./commands/logs.ts";
import { pokeRun } from "./commands/poke.ts";
import { listRunsForPs } from "./commands/ps.ts";
import { launchRun } from "./commands/run.ts";
import { resolveServiceTarget } from "./commands/service.ts";
import {
  restartService,
  serviceLogs,
  serviceStatus,
  startService,
  stopService,
} from "./commands/service-lifecycle.ts";
import { sweepWorktrees } from "./commands/sweep.ts";
import { unbindRepo } from "./commands/unbind.ts";
import { CliError } from "./errors.ts";
import { formatTable } from "./table.ts";

// No `.default()`: commander evaluates defaults eagerly, so resolving the
// factory's service URL here would walk the filesystem on `jigs --help`.
// Every action resolves it instead, inside the error handling.
const serviceOption = () =>
  new Option(
    "--service <url>",
    "jigs service URL (default: this factory's service.port in jigs.yml)",
  ).env("JIGS_SERVICE_URL");

const serviceTarget = (explicit?: string) =>
  resolveServiceTarget(process.cwd(), explicit);

function makeConfirm(): ((question: string) => Promise<boolean>) | undefined {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  return async (question) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const answer = await rl.question(`${question} [y/N] `);
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  };
}

function printBindingsTable(
  rows: BindingRow[],
  out: (line: string) => void,
): void {
  const lines = formatTable(
    ["NAME", "PATH", "REMOTE", "STATE"],
    rows.map((row) => [
      row.name,
      row.path,
      row.remote,
      row.notes.length > 0
        ? `${row.state} (${row.notes.join(", ")})`
        : row.state,
    ]),
  );
  for (const line of lines) out(line);
}

const out = (line: string) => console.log(line);

const program = new Command("jigs")
  .description("Guides coding agents through repeatable workflows")
  .showHelpAfterError("(add --help for additional information)");

program
  .command("init")
  .description("scaffold a factory repo in the current directory")
  .action(async () => {
    await initFactory({ cwd: process.cwd(), out });
  });

program
  .command("build")
  .description("compile this factory's pipelines into its service bundle")
  .action(async () => {
    await buildFactoryService({ cwd: process.cwd(), out });
  });

program
  .command("bind")
  .description("bind a repo checkout into this factory repo")
  .argument("<path>", "path to an existing git checkout with a remote")
  .option("--name <name>", "binding name (default: the repo dirname)")
  .action(async (target: string, options: { name?: string }) => {
    await bindRepo(
      target,
      { cwd: process.cwd(), confirm: makeConfirm(), out },
      { name: options.name },
    );
  });

program
  .command("unbind")
  .description("remove a binding")
  .argument("<name>", "binding name")
  .action((name: string) => {
    unbindRepo(name, { cwd: process.cwd(), out });
  });

program
  .command("run")
  .description("launch a pipeline")
  .argument("<pipeline>", "pipeline name")
  .option(
    "--input <pair>",
    "pipeline input as key=value (repeatable)",
    (pair: string, previous: string[]) => [...previous, pair],
    [] as string[],
  )
  .addOption(serviceOption())
  .action(
    async (
      pipeline: string,
      options: { input: string[]; service?: string },
    ) => {
      await launchRun(pipeline, options.input, {
        out,
        ...serviceTarget(options.service),
      });
    },
  );

program
  .command("ps")
  .description("list runs and the worktrees the registry holds")
  .addOption(serviceOption())
  .action(async (options: { service?: string }) => {
    await listRunsForPs({ out, ...serviceTarget(options.service) });
  });

program
  .command("cancel")
  .description("cancel a run, releasing every resource it claims")
  .argument("<run>", "run id, unique id prefix, or ticket id")
  .option("--force", "skip the confirmation for an in-flight run")
  .addOption(serviceOption())
  .action(
    async (run: string, options: { force?: boolean; service?: string }) => {
      await cancelRun(run, {
        out,
        ...serviceTarget(options.service),
        confirm: makeConfirm(),
        force: options.force,
      });
    },
  );

program
  .command("logs")
  .description("show a run's state and the workflow web pointer to its logs")
  .argument("<run>", "run id, unique id prefix, or ticket id")
  .addOption(serviceOption())
  .action(async (run: string, options: { service?: string }) => {
    await showLogs(run, { out, ...serviceTarget(options.service) });
  });

program
  .command("poke")
  .description("manually wake a suspended run (the missed-delivery fallback)")
  .argument("<run>", "run id, unique id prefix, or ticket id")
  .addOption(serviceOption())
  .action(async (runId: string, options: { service?: string }) => {
    await pokeRun(runId, { out, ...serviceTarget(options.service) });
  });

program
  .command("doctor")
  .description("run the check catalog against the service, without launching")
  .addOption(serviceOption())
  .action(async (options: { service?: string }) => {
    await runDoctor({ out, ...serviceTarget(options.service) });
  });

program
  .command("sweep")
  .description(
    "reconcile worktrees on disk against the registry and run states",
  )
  .option(
    "--force",
    "delete every eligible worktree without asking, dirty ones included",
  )
  .addOption(serviceOption())
  .action(async (options: { force?: boolean; service?: string }) => {
    await sweepWorktrees(
      { out, confirm: makeConfirm(), ...serviceTarget(options.service) },
      { force: options.force },
    );
  });

const service = program
  .command("service")
  .description("supervise this factory repo's service process");

service
  .command("start")
  .description("start this factory's service in the background")
  .action(() => {
    startService({ cwd: process.cwd(), out });
  });

service
  .command("stop")
  .description("stop this factory's service")
  .action(async () => {
    await stopService({ cwd: process.cwd(), out });
  });

service
  .command("restart")
  .description("stop then start this factory's service")
  .action(async () => {
    await restartService({ cwd: process.cwd(), out });
  });

service
  .command("status")
  .description("report whether this factory's service is running")
  .action(() => {
    serviceStatus({ cwd: process.cwd(), out });
  });

service
  .command("logs")
  .description("print the tail of the service process's output")
  .option("--lines <n>", "how many lines to print (default: 50)", (raw) => {
    const lines = Number(raw);
    if (!Number.isInteger(lines) || lines < 1) {
      throw new CliError(`--lines must be a positive integer, got ${raw}`);
    }
    return lines;
  })
  .action((options: { lines?: number }) => {
    serviceLogs({ cwd: process.cwd(), out }, { lines: options.lines });
  });

program
  .command("bindings")
  .description("list bindings with resolved state")
  .action(async () => {
    const rows = await listBindings({ cwd: process.cwd() });
    if (rows.length === 0) {
      out("no bindings");
      return;
    }
    printBindingsTable(rows, out);
  });

// Commander exits itself on its own parse errors; this catch sees only
// action-handler failures (parseAsync wraps even synchronous throws).
program.parseAsync().catch((err: unknown) => {
  if (err instanceof CliError) {
    console.error(`jigs: ${err.message}`);
    if (err.hint !== undefined) console.error(`  ${err.hint}`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
