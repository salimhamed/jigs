#!/usr/bin/env node
import readline from "node:readline/promises";
import { Command } from "commander";
import { bindRepo } from "./commands/bind.ts";
import { type BindingRow, listBindings } from "./commands/bindings.ts";
import { unbindRepo } from "./commands/unbind.ts";
import { CliError } from "./errors.ts";

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
  const cells = rows.map((row) => ({
    name: row.name,
    path: row.path,
    remote: row.remote,
    state:
      row.notes.length > 0
        ? `${row.state} (${row.notes.join(", ")})`
        : row.state,
  }));
  const all = [
    { name: "NAME", path: "PATH", remote: "REMOTE", state: "STATE" },
    ...cells,
  ];
  const widths = {
    name: Math.max(...all.map((row) => row.name.length)),
    path: Math.max(...all.map((row) => row.path.length)),
    remote: Math.max(...all.map((row) => row.remote.length)),
  };
  for (const row of all) {
    out(
      [
        row.name.padEnd(widths.name),
        row.path.padEnd(widths.path),
        row.remote.padEnd(widths.remote),
        row.state,
      ].join("  "),
    );
  }
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
