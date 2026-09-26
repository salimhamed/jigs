#!/usr/bin/env node
import readline from "node:readline/promises";
import { Command, Option } from "commander";
import type { LinearIdentity } from "../config/factory-config.ts";
import { JigsError } from "../errors.ts";
import { bindRepo } from "./commands/bind.ts";
import { listBindings } from "./commands/bindings.ts";
import { buildFactoryService } from "./commands/build.ts";
import { cancelRun } from "./commands/cancel.ts";
import { runDoctor } from "./commands/doctor.ts";
import { downFactory } from "./commands/down.ts";
import { generateIntegration } from "./commands/generate.ts";
import {
  type AppIdentityOptions,
  type IdentityMode,
  initFactory,
  resolveIdentityOptions,
} from "./commands/init.ts";
import { pokeRun } from "./commands/poke.ts";
import { addRecipe, recipeNames } from "./commands/recipe.ts";
import { listResources, runResourcesPrune } from "./commands/resources.ts";
import { launchRun } from "./commands/run.ts";
import { showRuns } from "./commands/run-list.ts";
import { resolveServiceUrl, usesFactoryService } from "./commands/service-client.ts";
import {
  restartService,
  serviceLogs,
  serviceStatus,
  startService,
  stopService,
} from "./commands/service-lifecycle.ts";
import { showRunStatus } from "./commands/status.ts";
import { unbindRepo } from "./commands/unbind.ts";
import { upFactory } from "./commands/up.ts";
import { upgradeFactory } from "./commands/upgrade.ts";
import { watchRuns } from "./commands/watch.ts";
import { listWorkflows } from "./commands/workflows.ts";

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

const RUN_ID_HELP = "the run's full ID, as listed by jigs status";

const ROOT_HELP = `Usage: jigs <command> [options]

Set up:
  init                      Scaffold a factory in the current directory
  upgrade                   Move to a newer jigs, run up, then typecheck
  doctor                    Check config, connections and required tools

Start and stop:
  up                        Start Postgres and the service, then run doctor
                            (reruns restart the service only if the build or
                            config changed)
  down                      Stop the service and Postgres; data is kept

Service process:
  service start             Start the service from the existing build
  service stop              Stop the service; Postgres keeps running
  service restart           Stop and start the service
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
  resources prune           Preview safe resource cleanup
  resources prune --apply   Perform eligible cleanup after safety checks

Generated code:
  build                     Compile workflows into the service bundle
  generate                  Refresh the generated jigs/ directory

A <run-id> is the run's full ID, which jigs status lists under RUN.
In a factory, run every command as
pnpm exec jigs <command>; add --help for its options.

Options:
  -h, --help                         Display help.
`;

const program = new Command("jigs").showHelpAfterError("(add --help for additional information)");

// Root help is a user journey rather than Commander's registration order.
// Overriding only this command leaves every command's generated help intact.
program.helpInformation = () => ROOT_HELP;

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
  .addOption(
    new Option(
      "--linear-identity-mode <mode>",
      "which Linear credential this factory is written for",
    )
      .choices(["key", "app"])
      .default("key"),
  )
  .action(
    async (
      options: {
        githubIdentityMode: IdentityMode;
        linearIdentityMode: LinearIdentity["mode"];
      } & AppIdentityOptions,
    ) => {
      await initFactory({
        cwd: process.cwd(),
        out,
        identity: resolveIdentityOptions(options.githubIdentityMode, options),
        linearIdentity: { mode: options.linearIdentityMode },
      });
    },
  );

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
  .command("generate")
  .description("refresh the generated jigs/ directory from the factory's installed jigs")
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
  .command("down")
  .description(
    "stop this factory's service process, then its Postgres container (docker compose down, volume kept)",
  )
  .action(async () => {
    await downFactory({ cwd: process.cwd(), out });
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
      { cwd: process.cwd(), out },
      { ...options, to: options.toVersion },
    );
    if (!result.ok) process.exitCode = 1;
  });

program
  .command("bind")
  .description("bind a target repo by its remote URL")
  .argument("<remote-url>", "the target repo's git remote (e.g. git@github.com:owner/repo.git)")
  .option(
    "--binding-name <binding-name>",
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
  .command("workflows")
  .description("list the workflows this built factory can run and their inputs")
  .addOption(serviceOption())
  .action(async (options: { serviceUrl?: string }) => {
    await listWorkflows({ out, serviceUrl: serviceUrl(options.serviceUrl) });
  });

program
  .command("status")
  .description("show all runs, or one run's status, steps, results, resources and dashboard link")
  .argument("[run-id]", RUN_ID_HELP)
  .option("--json", "print one JSON document instead of text output")
  .addOption(serviceOption())
  .action(async (runId: string | undefined, options: { json?: boolean; serviceUrl?: string }) => {
    const deps = { out, serviceUrl: serviceUrl(options.serviceUrl) };
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
        { out, serviceUrl: serviceUrl(options.serviceUrl) },
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
  .description("cancel a run; an operation or agent already executing may still finish")
  .argument("<run-id>", RUN_ID_HELP)
  .option("--force", "skip the confirmation for an in-flight run")
  .addOption(serviceOption())
  .action(async (run: string, options: { force?: boolean; serviceUrl?: string }) => {
    await cancelRun(run, {
      out,
      serviceUrl: serviceUrl(options.serviceUrl),
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
    await pokeRun(runId, { out, serviceUrl: serviceUrl(options.serviceUrl) });
  });

program
  .command("doctor")
  .description("run the check catalog against the service, without launching")
  .addOption(serviceOption())
  .action(async (options: { serviceUrl?: string }) => {
    await runDoctor({ out, serviceUrl: serviceUrl(options.serviceUrl) });
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
    await listResources({ cwd: process.cwd(), out }, options);
  });

resources
  .command("prune")
  .description("preview safe local resource cleanup; --apply performs it offline")
  .option("--run <run-id>", `limit the inventory to one run: ${RUN_ID_HELP}`)
  .option("--apply", "perform eligible cleanup after proving the service and children stopped")
  .option("--include-kept", "consider policy-kept resources, without bypassing Git safety")
  .option("--json", "print one JSON document")
  .action(
    async (options: { run?: string; apply?: boolean; includeKept?: boolean; json?: boolean }) => {
      await runResourcesPrune({ cwd: process.cwd(), out }, options);
    },
  );

const service = program
  .command("service")
  .description("supervise this factory's service process; Postgres is left running");

service
  .command("start")
  .description("start this factory's service process in the background")
  .action(async () => {
    await startService({ cwd: process.cwd(), out });
  });

service
  .command("stop")
  .description("stop this factory's service process and everything it started, dashboard included")
  .action(async () => {
    await stopService({ cwd: process.cwd(), out });
  });

service
  .command("restart")
  .description("stop then start this factory's service process")
  .action(async () => {
    await restartService({ cwd: process.cwd(), out });
  });

service
  .command("status")
  .description("report whether this factory's service process is running")
  .action(() => {
    serviceStatus({ cwd: process.cwd(), out });
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
    serviceLogs({ cwd: process.cwd(), out }, { lines: options.lines });
  });

program
  .command("bindings")
  .description("list bindings with their clone state")
  .action(async () => {
    await listBindings({ cwd: process.cwd(), out });
  });

if (process.argv.length === 2) {
  program.outputHelp();
} else {
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
}
