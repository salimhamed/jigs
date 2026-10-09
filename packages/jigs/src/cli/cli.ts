#!/usr/bin/env node
import readline from "node:readline/promises";
import { Command, Option } from "commander";
import { currentFactoryContext } from "../config/factory-context.ts";
import { locateFactoryRoot } from "../config/factory-root.ts";
import { JigsError } from "../errors.ts";
import { JIGS_VERSION } from "../version.ts";
import { bindRepo } from "./commands/bind.ts";
import { listBindings } from "./commands/bindings.ts";
import { buildFactoryService } from "./commands/build.ts";
import { cancelRun } from "./commands/cancel.ts";
import { runDoctor } from "./commands/doctor.ts";
import { downFactory } from "./commands/down.ts";
import { initFactory } from "./commands/init.ts";
import { pokeRun } from "./commands/poke.ts";
import { addRecipe, recipeNames } from "./commands/recipe.ts";
import { listResources, runResourcesPrune } from "./commands/resources.ts";
import { launchRun } from "./commands/run.ts";
import { showRuns } from "./commands/run-list.ts";
import { serviceLogs, serviceStatus, stopService } from "./commands/service.ts";
import { resolveServiceUrl, usesFactoryService } from "./commands/service-client.ts";
import { showRunStatus } from "./commands/status.ts";
import { unbindRepo } from "./commands/unbind.ts";
import { upFactory } from "./commands/up.ts";
import { watchRuns } from "./commands/watch.ts";
import { listWorkflows } from "./commands/workflows.ts";
import { formatError } from "./output.ts";

// No `.default()`: commander evaluates defaults eagerly, so resolving the
// factory's service URL here would walk the filesystem on `jigs --help`.
// Every action resolves it instead, inside the error handling.
const serviceOption = () =>
  new Option(
    "--service-url <url>",
    "jigs service URL (default: this factory's service.port in jigs.config.ts)",
  ).env("JIGS_SERVICE_URL");

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

const RUN_ID_HELP = "the run's full ID, as listed by jigs status";

const ROOT_HELP = `Usage: jigs <command> [options]

Set up:
  init                      Scaffold a factory in the current directory
  doctor                    Check config, connections and required tools

Start and stop:
  up                        Start Postgres and the service, then run doctor
                            (reruns restart the service only if the build or
                            config changed)
  down                      Stop the service and Postgres; data is kept

Service process:
  service stop              Stop the service; Postgres keeps running
  service status            Report whether the service is running
  service logs              Show recent service output

Workflows and runs:
  workflows                 List the workflows the service can run
  run <workflow-name>       Start a workflow
  status [run-id]           Show all runs, or full detail for one run
  watch [run-id]            Follow all runs, or only the selected run
  cancel <run-id>           Cancel a run
  poke <run-id>             Ask a suspended run to evaluate again

Repositories:
  bind <remote-url>         Connect a Git repository to this factory
  bindings                  List connected repositories and their clones
  unbind <binding-name>     Remove a connection; the remote is untouched

Recipes:
  recipe list               List the workflows jigs ships
  recipe add <recipe-name>  Copy one in, keeping files that already exist

Resources:
  resources list            Show run resources and working folders
  resources prune           Preview what --apply would remove, policy-kept included
  resources prune --apply   Remove it after the Git safety checks

Build:
  build                     Compile workflows into the service bundle

A <run-id> is the run's full ID, which jigs status lists under RUN.
In a factory, run every command as
pnpm exec jigs <command>; add --help for its options.

Options:
  -V, --version                      Print the installed jigs version.
  -h, --help                         Display help.
`;

const program = new Command("jigs")
  .version(JIGS_VERSION, "-V, --version")
  .showHelpAfterError("(add --help for additional information)");

// Root help is a user journey rather than Commander's registration order.
// Overriding only this command leaves every command's generated help intact.
program.helpInformation = () => ROOT_HELP;

// Every command but init runs from the factory root with its config loaded,
// so whatever the config puts in the environment is there before anything,
// commander's own option defaults included, reads it.
program.hook("preSubcommand", (_program, command) => {
  if (command.name() === "init") return;
  process.chdir(locateFactoryRoot(process.cwd()));
  currentFactoryContext().config;
});

program
  .command("init")
  .description("scaffold a factory repo in the current directory")
  .action(async () => {
    await initFactory({ cwd: process.cwd(), out });
  });

const recipe = program.command("recipe").description("copy a shipped workflow into this factory");
recipe
  .command("list")
  .description("list shipped recipes")
  .action(() => {
    for (const name of recipeNames()) out(name);
  });
recipe
  .command("add <recipe-name>")
  .description("copy a recipe, preserving existing files")
  .action((name: string) => {
    addRecipe(name, { cwd: process.cwd(), out });
  });

program
  .command("build")
  .description("compile this factory's workflows into its service bundle")
  .action(async () => {
    await buildFactoryService({ out });
  });

program
  .command("up")
  .description(
    "take this factory from any state to a running service (install, compose, bootstrap, build, start, doctor)",
  )
  .option("--restart-service", "restart the service even when the bundle is unchanged")
  .option("--force", "restart over executing steps without asking")
  .option("--no-doctor", "skip the doctor pass once the service is up")
  .action(async (options: { restartService?: boolean; force?: boolean; doctor: boolean }) => {
    // Every step has already printed its own FAIL line and repair, so the
    // exit code is the only thing left to say.
    const result = await upFactory(
      { out, confirm: makeConfirm() },
      { ...options, restart: options.restartService },
    );
    if (!result.ok) process.exitCode = 1;
  });

program
  .command("down")
  .description(
    "stop this factory's service process, then its Postgres container (docker compose down, volume kept)",
  )
  .action(async () => {
    await downFactory({ out });
  });

program
  .command("bind")
  .description("bind a target repo by its remote URL")
  .argument("<remote-url>", "the target repo's git remote (e.g. git@github.com:owner/repo.git)")
  .option(
    "--binding-name <binding-name>",
    "binding name (default: an existing exact-remote match, else the repo name lowercased)",
  )
  .option(
    "--installation <installation-name>",
    "the GitHub App installation, as named on the hub, that reaches the repo (default: the binding's own)",
  )
  .action(async (remoteUrl: string, options: { bindingName?: string; installation?: string }) => {
    await bindRepo(
      remoteUrl,
      { out },
      {
        ...(options.bindingName === undefined ? {} : { name: options.bindingName }),
        ...(options.installation === undefined ? {} : { installation: options.installation }),
      },
    );
  });

program
  .command("unbind")
  .description("remove a binding")
  .argument("<binding-name>", "binding name")
  .action((name: string) => {
    unbindRepo(name, { out });
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
      ownService: usesFactoryService(options.serviceUrl),
      serviceUrl: resolveServiceUrl(options.serviceUrl),
    });
  });

program
  .command("workflows")
  .description("list the workflows this built factory can run and their inputs")
  .addOption(serviceOption())
  .action(async (options: { serviceUrl?: string }) => {
    await listWorkflows({ out, serviceUrl: resolveServiceUrl(options.serviceUrl) });
  });

program
  .command("status")
  .description("show all runs, or one run's status, steps, results, resources and dashboard link")
  .argument("[run-id]", RUN_ID_HELP)
  .option("--json", "print one JSON document instead of text output")
  .addOption(serviceOption())
  .action(async (runId: string | undefined, options: { json?: boolean; serviceUrl?: string }) => {
    const deps = { out, serviceUrl: resolveServiceUrl(options.serviceUrl) };
    if (runId === undefined) await showRuns(deps, { json: options.json });
    else await showRunStatus(runId, deps, { json: options.json });
  });

program
  .command("watch")
  .description("follow all runs, or only one run: one line per change")
  .argument("[run-id]", RUN_ID_HELP)
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
    async (
      runId: string | undefined,
      options: { json?: boolean; pollIntervalSeconds?: number; serviceUrl?: string },
    ) => {
      await watchRuns(
        { out, serviceUrl: resolveServiceUrl(options.serviceUrl) },
        {
          json: options.json,
          runId,
          ...(options.pollIntervalSeconds === undefined
            ? {}
            : { intervalMs: options.pollIntervalSeconds * 1000 }),
        },
      );
    },
  );

program
  .command("cancel")
  .description(
    "cancel a run; a running agent stops within seconds, other step work may still finish",
  )
  .argument("<run-id>", RUN_ID_HELP)
  .option("--force", "skip the confirmation for an in-flight run")
  .addOption(serviceOption())
  .action(async (run: string, options: { force?: boolean; serviceUrl?: string }) => {
    await cancelRun(run, {
      out,
      serviceUrl: resolveServiceUrl(options.serviceUrl),
      confirm: makeConfirm(),
      force: options.force,
    });
  });

program
  .command("poke")
  .description("ask a suspended run to evaluate again; does not bypass approvals or add answers")
  .argument("<run-id>", RUN_ID_HELP)
  .addOption(serviceOption())
  .action(async (runId: string, options: { serviceUrl?: string }) => {
    await pokeRun(runId, { out, serviceUrl: resolveServiceUrl(options.serviceUrl) });
  });

program
  .command("doctor")
  .description("run the check catalog against the service, without launching")
  .addOption(serviceOption())
  .action(async (options: { serviceUrl?: string }) => {
    await runDoctor({ out, serviceUrl: resolveServiceUrl(options.serviceUrl) });
  });

const resources = program
  .command("resources")
  .description("inspect and safely prune this factory's registered local resources");

resources
  .command("list")
  .description("list registered resources without changing them")
  .option("--run <run-id>", `limit the inventory to one run: ${RUN_ID_HELP}`)
  .option("--json", "print one JSON document")
  .action(async (options: { run?: string; json?: boolean }) => {
    await listResources({ out }, options);
  });

resources
  .command("prune")
  .description(
    "preview removing finished runs' resources, including ones the release policy kept; --apply removes them offline",
  )
  .option("--run <run-id>", `limit the inventory to one run: ${RUN_ID_HELP}`)
  .option("--apply", "remove them once the service and everything it started have stopped")
  .option("--json", "print one JSON document")
  .action(async (options: { run?: string; apply?: boolean; json?: boolean }) => {
    await runResourcesPrune({ out }, options);
  });

const service = program
  .command("service")
  .description("supervise this factory's service process; Postgres is left running");

service
  .command("stop")
  .description("stop this factory's service process and everything it started, dashboard included")
  .action(async () => {
    await stopService({ out });
  });

service
  .command("status")
  .description("report whether this factory's service process is running")
  .action(() => {
    serviceStatus({ out });
  });

service
  .command("logs")
  .description("print the tail of the service process's output")
  .option("--lines <line-count>", "how many lines to print (default: 50)", (raw) => {
    const lines = Number(raw);
    if (!Number.isInteger(lines) || lines < 1) {
      throw new JigsError(`--lines must be a positive integer, got ${raw}`);
    }
    return lines;
  })
  .action((options: { lines?: number }) => {
    serviceLogs({ out }, { lines: options.lines });
  });

program
  .command("bindings")
  .description("list bindings with their clone state")
  .action(async () => {
    await listBindings({ out });
  });

if (process.argv.length === 2) {
  program.outputHelp();
} else {
  // Commander exits itself on its own parse errors; this catch sees hook and
  // action failures (parseAsync wraps even synchronous throws).
  program.parseAsync().catch((err: unknown) => {
    if (err instanceof JigsError) {
      for (const line of formatError(err)) console.error(line);
    } else {
      console.error(err);
    }
    process.exitCode = 1;
  });
}
