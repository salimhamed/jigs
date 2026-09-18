#!/usr/bin/env node
import readline from "node:readline/promises";
import { Command, Option } from "commander";
import { JigsError } from "../errors.ts";
import { bindRepo } from "./commands/bind.ts";
import { listBindings } from "./commands/bindings.ts";
import { buildFactoryService } from "./commands/build.ts";
import { cancelRun } from "./commands/cancel.ts";
import { runDoctor } from "./commands/doctor.ts";
import { generateIntegration } from "./commands/generate.ts";
import {
  type AppIdentityOptions,
  type IdentityMode,
  initFactory,
  resolveIdentityOptions,
} from "./commands/init.ts";
import { showLogs } from "./commands/logs.ts";
import { pokeRun } from "./commands/poke.ts";
import { showRuns } from "./commands/ps.ts";
import { addRecipe, recipeNames } from "./commands/recipe.ts";
import { launchRun } from "./commands/run.ts";
import { resolveServiceUrl, usesFactoryService } from "./commands/service-client.ts";
import {
  restartService,
  serviceLogs,
  serviceStatus,
  startService,
  stopService,
} from "./commands/service-lifecycle.ts";
import { runSweep } from "./commands/sweep.ts";
import { unbindRepo } from "./commands/unbind.ts";
import { upFactory } from "./commands/up.ts";
import { upgradeFactory } from "./commands/upgrade.ts";
import { watchRuns } from "./commands/watch.ts";

// No `.default()`: commander evaluates defaults eagerly, so resolving the
// factory's service URL here would walk the filesystem on `jigs --help`.
// Every action resolves it instead, inside the error handling.
const serviceOption = () =>
  new Option(
    "--service-url <url>",
    "jigs service URL (default: this factory's service.port in jigs.config.ts)",
  ).env("JIGS_SERVICE_URL");

const serviceUrl = (explicit?: string) => resolveServiceUrl(process.cwd(), explicit);

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

const out = (line: string) => console.log(line);

const program = new Command("jigs")
  .description("Guides coding agents through repeatable workflows")
  .showHelpAfterError("(add --help for additional information)");

program
  .command("init")
  .description("scaffold a factory repo in the current directory")
  .addOption(
    new Option(
      "--github-identity-mode <mode>",
      "which GitHub credential this factory is written for",
    )
      .choices(["pat", "app"])
      .default("pat"),
  )
  // Required together by --github-identity-mode app, and refused there as a set rather
  // than defaulted: a scaffold with placeholder ids does not load.
  .option("--github-app-id <id>", "GitHub App id (--github-identity-mode app)")
  .option(
    "--github-app-installation <account=installation-id>",
    "App installation by account (repeatable)",
    (value: string, previous: string[]) => [...previous, value],
    [],
  )
  .option(
    "--github-app-private-key-path <path>",
    "the App's private key .pem (--github-identity-mode app)",
  )
  .option("--github-operator-login <login>", "your GitHub login (--github-identity-mode app)")
  .option(
    "--git-co-author <author>",
    '"Name <email>" for merge commit trailers (--github-identity-mode app)',
  )
  .action(async (options: { githubIdentityMode: IdentityMode } & AppIdentityOptions) => {
    await initFactory({
      cwd: process.cwd(),
      out,
      identity: resolveIdentityOptions(options.githubIdentityMode, options),
    });
  });

const recipe = program.command("recipe").description("copy a shipped workflow into this factory");
recipe
  .command("list")
  .description("list shipped recipes")
  .action(() => {
    for (const name of recipeNames()) out(name);
  });
recipe
  .command("add <name>")
  .description("copy a recipe, preserving existing files")
  .action((name: string) => {
    addRecipe(name, { cwd: process.cwd(), out });
  });

program
  .command("generate")
  .description("refresh the committed jigs.ts integration from the factory's installed jigs")
  .action(async () => {
    await generateIntegration({ cwd: process.cwd(), out });
  });

program
  .command("build")
  .description("compile this factory's workflows into its service bundle")
  .action(async () => {
    await buildFactoryService({ cwd: process.cwd(), out });
  });

program
  .command("up")
  .description(
    "take this factory from any state to a running service (env, install, compose, bootstrap, build, start, doctor)",
  )
  .option("--restart-service", "restart the service even when the bundle is unchanged")
  .option("--force", "restart over in-flight runs without asking")
  .option("--no-doctor", "skip the doctor pass once the service is up")
  .action(async (options: { restartService?: boolean; force?: boolean; doctor: boolean }) => {
    // Every step has already printed its own FAIL line and repair, so the
    // exit code is the only thing left to say.
    const result = await upFactory(
      { cwd: process.cwd(), out, confirm: makeConfirm() },
      { ...options, restart: options.restartService },
    );
    if (!result.ok) process.exitCode = 1;
  });

program
  .command("upgrade")
  .description(
    "move this factory to a newer jigs: bump the package, then up, then the factory's typecheck",
  )
  .option("--to-version <version>", "pin jigs to this version instead of the latest release")
  .option("--force", "restart over in-flight runs without asking")
  .option("--no-doctor", "skip the doctor pass once the service is up")
  .action(async (options: { toVersion?: string; force?: boolean; doctor: boolean }) => {
    const result = await upgradeFactory(
      { cwd: process.cwd(), out, confirm: makeConfirm() },
      { ...options, to: options.toVersion },
    );
    if (!result.ok) process.exitCode = 1;
  });

program
  .command("bind")
  .description("bind a target repo by its remote URL")
  .argument("<remote-url>", "the target repo's git remote (e.g. git@github.com:owner/repo.git)")
  .option(
    "--binding-name <name>",
    "binding name (default: an existing exact-remote match, else the repo name lowercased)",
  )
  .action(async (remoteUrl: string, options: { bindingName?: string }) => {
    await bindRepo(remoteUrl, { cwd: process.cwd(), out }, { name: options.bindingName });
  });

program
  .command("unbind")
  .description("remove a binding")
  .argument("<binding-name>", "binding name")
  .action((name: string) => {
    unbindRepo(name, { cwd: process.cwd(), out });
  });

program
  .command("run")
  .description("launch a workflow")
  .argument("<workflow-name>", "workflow name")
  .option(
    "--input <key=value>",
    "workflow input as key=value (repeatable)",
    (pair: string, previous: string[]) => [...previous, pair],
    [] as string[],
  )
  .addOption(serviceOption())
  .action(async (workflow: string, options: { input: string[]; serviceUrl?: string }) => {
    await launchRun(workflow, options.input, {
      out,
      factoryCwd: usesFactoryService(options.serviceUrl) ? process.cwd() : undefined,
      serviceUrl: serviceUrl(options.serviceUrl),
    });
  });

program
  .command("ps")
  .description("list runs with their ticket, status and what they wait on")
  .option("--json", "print one JSON document instead of the tables")
  .addOption(serviceOption())
  .action(async (options: { json?: boolean; serviceUrl?: string }) => {
    await showRuns({ out, serviceUrl: serviceUrl(options.serviceUrl) }, { json: options.json });
  });

program
  .command("watch")
  .description(
    "follow every run in this factory: one line per step, suspension, resume, terminal state and new run",
  )
  .option("--json", "emit one JSON event per line instead of text")
  .option(
    "--poll-interval-seconds <seconds>",
    "how often to poll the service (default: 5)",
    (raw) => {
      const seconds = Number(raw);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new JigsError(
          `--poll-interval-seconds must be a positive number of seconds, got ${raw}`,
        );
      }
      return seconds;
    },
  )
  .addOption(serviceOption())
  .action(
    async (options: { json?: boolean; pollIntervalSeconds?: number; serviceUrl?: string }) => {
      await watchRuns(
        { out, serviceUrl: serviceUrl(options.serviceUrl) },
        {
          json: options.json,
          ...(options.pollIntervalSeconds === undefined
            ? {}
            : { intervalMs: options.pollIntervalSeconds * 1000 }),
        },
      );
    },
  );

program
  .command("cancel")
  .description("cancel a run, releasing every resource it claims")
  .argument("<run>", "run id, unique id prefix, or ticket (`AGE-123` or its UUID)")
  .option("--discard-worktrees", "remove the run's worktrees after cancelling")
  .option("--force", "skip the confirmation for an in-flight run")
  .addOption(serviceOption())
  .action(
    async (
      run: string,
      options: { discardWorktrees?: boolean; force?: boolean; serviceUrl?: string },
    ) => {
      await cancelRun(run, {
        out,
        serviceUrl: serviceUrl(options.serviceUrl),
        confirm: makeConfirm(),
        discard: options.discardWorktrees,
        force: options.force,
      });
    },
  );

program
  .command("logs")
  .description("show a run's state, what it waits on, its step timeline, and dashboard link")
  .argument("<run>", "run id, unique id prefix, or ticket (`AGE-123` or its UUID)")
  .option("--json", "print one JSON document instead of the report")
  .addOption(serviceOption())
  .action(async (run: string, options: { json?: boolean; serviceUrl?: string }) => {
    await showLogs(
      run,
      { out, serviceUrl: serviceUrl(options.serviceUrl) },
      { json: options.json },
    );
  });

program
  .command("poke")
  .description("manually wake a suspended run (the missed-delivery fallback)")
  .argument("<run>", "run id, unique id prefix, or ticket (`AGE-123` or its UUID)")
  .addOption(serviceOption())
  .action(async (runId: string, options: { serviceUrl?: string }) => {
    await pokeRun(runId, { out, serviceUrl: serviceUrl(options.serviceUrl) });
  });

program
  .command("doctor")
  .description("run the check catalog against the service, without launching")
  .addOption(serviceOption())
  .action(async (options: { serviceUrl?: string }) => {
    await runDoctor({ out, serviceUrl: serviceUrl(options.serviceUrl) });
  });

program
  .command("sweep")
  .description("reconcile worktrees on disk against the registry and run states")
  .argument("[resource-path]", "remove only this worktree or run directory")
  .option("--force", "delete every eligible worktree without asking, dirty ones included")
  .addOption(serviceOption())
  .action(async (path: string | undefined, options: { force?: boolean; serviceUrl?: string }) => {
    await runSweep(
      { out, confirm: makeConfirm(), serviceUrl: serviceUrl(options.serviceUrl) },
      {
        force: options.force,
        ...(path === undefined ? {} : { paths: [path] }),
      },
    );
  });

const service = program
  .command("service")
  .description("supervise this factory repo's service process");

service
  .command("start")
  .description("start this factory's service in the background")
  .action(async () => {
    await startService({ cwd: process.cwd(), out });
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
      throw new JigsError(`--lines must be a positive integer, got ${raw}`);
    }
    return lines;
  })
  .action((options: { lines?: number }) => {
    serviceLogs({ cwd: process.cwd(), out }, { lines: options.lines });
  });

program
  .command("bindings")
  .description("list bindings with their clone state")
  .action(async () => {
    await listBindings({ cwd: process.cwd(), out });
  });

// Commander exits itself on its own parse errors; this catch sees only
// action-handler failures (parseAsync wraps even synchronous throws).
program.parseAsync().catch((err: unknown) => {
  if (err instanceof JigsError) {
    console.error(`jigs: ${err.message}`);
    if (err.hint !== undefined) console.error(`  ${err.hint}`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
