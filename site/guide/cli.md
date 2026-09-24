# CLI commands

Run every command inside your factory, as `pnpm exec jigs <command>`, so it uses
that factory's installed version of jigs. The exception is `init`, which runs
before there is a factory:
`pnpm --config.minimum-release-age-exclude=@jigs-ai/jigs dlx @jigs-ai/jigs init`.
Add `--help` to a command to see its options.

## Everyday commands

| Command | What it does |
| --- | --- |
| `jigs init` | Create a factory in the current directory. Keeps existing files. |
| `jigs up` | Install, start Postgres, build, start the service, wait until ready, then run `jigs doctor`. |
| `jigs down` | Stop the service, then Postgres (`docker compose down`). Postgres's data is kept. |
| `jigs workflows` | List the workflows the running service can run, and their inputs. |
| `jigs run <workflow> --input key=value` | Start a run. Repeat `--input` for each input. |
| `jigs status [run]` | Show all runs and schedules, or one run's steps, result, resources and what it waits for. |
| `jigs watch [run]` | Follow all runs, or one, printing a line per change. |
| `jigs cancel <run>` | Cancel a run. |
| `jigs doctor` | Check configuration, credentials and tools against the running service. |
| `jigs upgrade` | Move the factory to the latest jigs and bring it up. |

## Repositories

| Command | What it does |
| --- | --- |
| `jigs bind <remote-url>` | Add a binding for a repository, and create its approval label or webhook when configured. |
| `jigs bindings` | List bindings, their clone paths and whether each clone exists. |
| `jigs unbind <name>` | Remove a binding. The clone stays on disk for you to delete. |

## Recipes

| Command | What it does |
| --- | --- |
| `jigs recipe list` | List the recipes that ship with jigs. |
| `jigs recipe add <name>` | Copy a recipe into the factory, keeping existing files. See [Recipes](/guide/recipes). |

## Resources

| Command | What it does |
| --- | --- |
| `jigs resources list` | List each run's worktrees, scratch directories and recorded resources. Changes nothing. |
| `jigs resources prune` | Preview what could be safely removed. |
| `jigs resources prune --apply` | Remove it. Needs the service stopped. |

## Service

| Command | What it does |
| --- | --- |
| `jigs service start` | Start the service from the current build and wait until it is ready. |
| `jigs service stop` | Stop the service, giving in-flight work a few seconds to finish. Postgres keeps running. |
| `jigs service restart` | Stop, then start. |
| `jigs service status` | Say whether the service runs, with its service and dashboard URLs. |
| `jigs service logs` | Print the service's recent output. `--lines` sets how many. |

The service hosts its own dashboard. Do not run the Workflow SDK's
`workflow web` against a factory; see
[Troubleshooting](/guide/troubleshooting#runs-stop-moving-after-you-ran-workflow-web).

## Advanced

| Command | What it does |
| --- | --- |
| `jigs build` | Compile the workflows into the service bundle. `jigs up` runs it for you. |
| `jigs generate` | Refresh the generated `jigs.ts` from the installed jigs version. |
| `jigs poke <run>` | Make a waiting run check its condition now. It does not answer the wait for it. |

## Choosing a run

Wherever a command takes a run, you can give a complete run ID, a unique prefix
of one, or the ticket the run claimed, such as `AGE-123`. An ambiguous prefix
lists the matches instead of guessing. `status`, `watch` and `resources` take
`--json` for machine-readable output.

`--input` values are read as JSON when they parse, and as plain strings
otherwise, so `count=3` is a number and `ticket=AGE-123` is a string. A value
the workflow's schema rejects fails before any run is created.

## `jigs up` on a running service

`jigs up` is also the command to run after every change. Each step is skipped
when there is nothing to do, so an unchanged factory installs, migrates and
restarts nothing.

When the service is already running, `up` restarts it only if the built bundle
or `jigs.config.ts` changed. `--restart-service` forces a restart. If any run has not finished,
`up` lists those runs and asks before restarting over them; `--force` skips the
question, and without a terminal to ask in, it refuses.

If a step fails, `up` prints `FAIL <step>` with a repair on the next line. Fix
it and run `jigs up` again.

## Upgrading jigs

`jigs upgrade` moves the factory's jigs pin to the latest release, or to
`--to-version <version>`. Then, using the newly installed version, it
regenerates `jigs.ts`, runs `jigs up` and runs the factory's typecheck. Review
and commit the changes it makes. Your workflows and copied recipes are yours to
update: a new release can change an API they use, and the typecheck tells you
where.

## Cancelling

`jigs cancel` ends a waiting run immediately, and asks first when the run is in
the middle of a step (`--force` skips the question). A step already running may
still finish its outside work, but the run does not continue. Cancel lists any
worktrees it leaves behind.

## Cleaning up resources

`jigs resources prune` only previews unless you add `--apply`. To apply:

1. Run `jigs service stop`.
2. Check the preview, optionally for one run with `--run <run>`.
3. Run `jigs resources prune --apply`.

Only resources of finished runs owned by this factory are removed. A worktree
with uncommitted changes, an unmerged branch, a waiting run's resources and
anything jigs cannot prove it owns are always kept. Resources a release policy
chose to keep need `--include-kept`, which relaxes nothing else. Applying needs
proof that the service and its agents have stopped, which jigs gets from the
factory's systemd user scope, so it only works on Linux hosts with systemd.
