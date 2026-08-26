#!/usr/bin/env node
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { bindRepo } from "./commands/bind.ts";
import { type BindingRow, listBindings } from "./commands/bindings.ts";
import { unbindRepo } from "./commands/unbind.ts";
import { CliError } from "./errors.ts";

const USAGE = `usage: jigs <command>

commands:
  bind <path> [--name <n>]   bind a repo checkout into this factory repo
  unbind <name>              remove a binding
  bindings                   list bindings with resolved state`;

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
  const width = (key: "name" | "path" | "remote") =>
    Math.max(...all.map((row) => row[key].length));
  for (const row of all) {
    out(
      [
        row.name.padEnd(width("name")),
        row.path.padEnd(width("path")),
        row.remote.padEnd(width("remote")),
        row.state,
      ].join("  "),
    );
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const out = (line: string) => console.log(line);

  switch (command) {
    case "bind": {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { name: { type: "string" } },
        allowPositionals: true,
      });
      const target = positionals[0];
      if (target === undefined || positionals.length > 1) {
        throw new CliError("usage: jigs bind <path> [--name <n>]");
      }
      await bindRepo(
        target,
        { cwd: process.cwd(), confirm: makeConfirm(), out },
        { name: values.name },
      );
      return;
    }
    case "unbind": {
      const { positionals } = parseArgs({
        args: rest,
        options: {},
        allowPositionals: true,
      });
      const name = positionals[0];
      if (name === undefined || positionals.length > 1) {
        throw new CliError("usage: jigs unbind <name>");
      }
      unbindRepo(name, { cwd: process.cwd(), out });
      return;
    }
    case "bindings": {
      parseArgs({ args: rest, options: {} });
      const rows = await listBindings({ cwd: process.cwd() });
      if (rows.length === 0) {
        out("no bindings");
        return;
      }
      printBindingsTable(rows, out);
      return;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h": {
      out(USAGE);
      return;
    }
    default:
      throw new CliError(`unknown command: ${command}`, USAGE);
  }
}

main().catch((err: unknown) => {
  if (err instanceof CliError) {
    console.error(`jigs: ${err.message}`);
    if (err.hint !== undefined) console.error(`  ${err.hint}`);
  } else if (
    err instanceof Error &&
    "code" in err &&
    String((err as { code: unknown }).code).startsWith("ERR_PARSE_ARGS")
  ) {
    console.error(`jigs: ${err.message}`);
    console.error(`  ${USAGE}`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
