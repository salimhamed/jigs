#!/usr/bin/env node
import readline from "node:readline/promises";
import { Command, Option } from "commander";
import { bindRepo } from "./commands/bind.ts";
import { type BindingRow, listBindings } from "./commands/bindings.ts";
import { cancelRun } from "./commands/cancel.ts";
import { runDoctor } from "./commands/doctor.ts";
import { showLogs } from "./commands/logs.ts";
import { pokeRun } from "./commands/poke.ts";
import { listRunsForPs } from "./commands/ps.ts";
import { launchRun } from "./commands/run.ts";
import { unbindRepo } from "./commands/unbind.ts";
import { CliError } from "./errors.ts";
import { formatTable } from "./table.ts";

const serviceOption = () =>
  new Option("--service <url>", "jigs service URL")
    .env("JIGS_SERVICE_URL")
    .default("http://localhost:8990");

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
    async (pipeline: string, options: { input: string[]; service: string }) => {
      await launchRun(pipeline, options.input, {
        out,
        serviceUrl: options.service,
      });
    },
  );

program
  .command("ps")
  .description("list runs and the worktrees the registry holds")
  .addOption(serviceOption())
  .action(async (options: { service: string }) => {
    await listRunsForPs({ out, serviceUrl: options.service });
  });

program
  .command("cancel")
  .description("cancel a run, releasing every resource it claims")
  .argument("<run>", "run id, unique id prefix, or ticket id")
  .option("--force", "skip the confirmation for an in-flight run")
  .addOption(serviceOption())
  .action(
    async (run: string, options: { force?: boolean; service: string }) => {
      await cancelRun(run, {
        out,
        serviceUrl: options.service,
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
  .action(async (run: string, options: { service: string }) => {
    await showLogs(run, { out, serviceUrl: options.service });
  });

program
  .command("poke")
  .description("manually wake a suspended run (the missed-delivery fallback)")
  .argument("<run>", "run id, unique id prefix, or ticket id")
  .addOption(serviceOption())
  .action(async (runId: string, options: { service: string }) => {
    await pokeRun(runId, { out, serviceUrl: options.service });
  });

program
  .command("doctor")
  .description("run the check catalog against the service, without launching")
  .addOption(serviceOption())
  .action(async (options: { service: string }) => {
    await runDoctor({ out, serviceUrl: options.service });
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
