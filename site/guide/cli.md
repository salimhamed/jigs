# CLI commands

Run every command inside your factory, as `pnpm exec jigs <command>`, so it uses
that factory's installed version of jigs. The exception is `init`, which runs
before there is a factory:
`pnpm dlx @jigs-ai/jigs init`.
Add `--help` to a command to see its options.

::: tip Installing a very recent release
If pnpm's minimum release age blocks a release you want to use, run:

```sh
pnpm --config.minimum-release-age-exclude=@jigs-ai/jigs dlx @jigs-ai/jigs init
```

This bypasses that restriction for jigs. It does not force a `dlx` cache refresh.
:::

## Factory

| Command | What it does |
| --- | --- |
| `jigs init` | Create a factory in the current directory. Keeps existing files. |
| `jigs up` | Install, start Postgres, build, start the service, wait until ready, then run `jigs doctor`. |
| `jigs down` | Stop the service, then Postgres (`docker compose down`). Postgres's data is kept. |
| `jigs doctor` | Check configuration, credentials and tools against the running service. |
| `jigs upgrade` | Move the factory to the latest jigs and bring it up. |

## Runs

| Command | What it does |
| --- | --- |
| `jigs workflows` | List the workflows the running service can run, and their inputs. |
| `jigs run <workflow> --input key=value` | Start a run. Repeat `--input` for each input. |
| `jigs status [run]` | Show all runs and schedules, or one run's steps, result, resources and what it waits for. |
| `jigs watch [run]` | Follow all runs, or one, printing a line per change. |
| `jigs cancel <run>` | Cancel a run. |
| `jigs poke <run>` | Ask a waiting run to check its condition now, without answering it. |

### Choosing a run

Wherever a command takes a run, give its full run ID, such as
`wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM`. A prefix of an ID or a ticket such as
`AGE-123` is not found. To find a run's ID, run `jigs status`: its `RUN` column
lists each run's ID and its `TICKET` column the ticket the run was launched
for. `status`, `watch` and `resources` take `--json` for machine-readable
output.

### Input values

`--input` values are read as JSON when they parse, and as plain strings
otherwise, so `count=3` is a number and `ticket=AGE-123` is a string. A value
the workflow's schema rejects fails before any run is created.

## Repositories

| Command | What it does |
| --- | --- |
| `jigs bind <remote-url>` | Add a binding for a repository, create the factory's `bindings/<name>/` folder for [copied files](/guide/configuration#bindings) if it is missing, create the `jigs:approved` label, and create its webhook when configured. |
| `jigs bindings` | List bindings, their clone paths and whether each clone exists. |
| `jigs unbind <name>` | Remove a binding. The clone stays on disk for you to delete, and so does the factory's `bindings/<name>/` folder. |

jigs keeps each binding's clone and worktrees under
`~/.local/share/jigs/clones/`. That folder is separate from the factory's
`bindings/<name>/`, which holds files you want copied into each worktree.

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
| `jigs resources prune --apply` | Remove it. Needs `jigs service stop` first. |

## Service

Use `jigs up` and `jigs down` for ordinary startup and shutdown. Direct service
commands are useful for restarting after `.env` edits, inspecting logs or
managing only the service.

| Command | What it does |
| --- | --- |
| `jigs service start` | Start the service from the current build and wait until it is ready. |
| `jigs service stop` | Stop the service and everything it started, giving in-flight work up to 10 seconds to finish. Postgres keeps running. |
| `jigs service restart` | Stop, then start. |
| `jigs service status` | Say whether the service runs, with its service and dashboard URLs. |
| `jigs service logs` | Print the service's recent output. `--lines` sets how many. |

The service hosts its own dashboard. Do not run the Workflow SDK's
`workflow web` against a factory; see
[Troubleshooting](/guide/troubleshooting#runs-stop-moving-after-you-ran-workflow-web).

### Stopping the service

`jigs service stop`, `jigs service restart`, `jigs down` and a restart inside
`jigs up` all stop the service the same way, on macOS and Linux. They stop the
service and every process it started, such as running agents, their commands
and anything those commands started. Each gets a termination signal and up to
10 seconds to exit; whatever is still running after that is killed. An agent's
step that was cut off runs again after the next start.

If a process survives, the command fails and lists its process ID and command
so you can end it yourself.

Two kinds of process can outlive a stop:

- A process an agent fully detached from the service, for example with
  `setsid` or a double fork, can survive.
- Docker containers an agent started, for example with `docker compose up`, run
  under the Docker daemon and are not stopped.

### Service lifetime

jigs starts and stops the service process itself. It keeps running until you
stop it, log out or restart the machine. To start the factory each time you log
in, have the operating system run `pnpm exec jigs up` once in the factory
directory.

Do not point launchd's `KeepAlive` or systemd's `Restart=` at the service. The
manager would restart it after `jigs service stop`, and jigs would lose track
of it.

**macOS.** Save a LaunchAgent as `~/Library/LaunchAgents/dev.jigs.my-factory.plist`,
with your factory's path in place of `/Users/me/my-factory`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.jigs.my-factory</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>pnpm exec jigs up</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/me/my-factory</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/me/Library/Logs/my-factory-up.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/me/Library/Logs/my-factory-up.log</string>
</dict>
</plist>
```

The login shell (`zsh -l`) loads your profile, so `pnpm` and `node` are found.
Load it with
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.jigs.my-factory.plist`,
which runs it now and at every login from then on. Your Docker runtime must
also start at login, since `jigs up` starts Postgres with Docker Compose.

**Linux.** Save a systemd user unit as `~/.config/systemd/user/my-factory.service`:

```ini
[Unit]
Description=Start my-factory

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=%h/my-factory
ExecStart=/bin/bash -lc 'pnpm exec jigs up'

[Install]
WantedBy=default.target
```

Enable it with `systemctl --user enable my-factory.service`. It runs once at
login. To have it run at boot without logging in, also run
`loginctl enable-linger "$USER"`.

`jigs up` exits once the factory is running, and `oneshot` with
`RemainAfterExit` tells systemd that is expected. Stop the factory with
`pnpm exec jigs down` as usual, not with `systemctl`.

## Advanced/build

| Command | What it does |
| --- | --- |
| `jigs build` | Compile the workflows into the service bundle. `jigs up` runs it for you. |
| `jigs generate` | Refresh the generated `jigs/steps.ts` and `jigs/routines.ts` from the installed jigs version. |

## `jigs up` on a running service

Use `jigs up` after changing workflow code or configuration:

- Unchanged install, migration and build work is skipped.
- The service restarts only when the built bundle or `jigs.config.ts` changes.
  `--restart-service` forces a restart.
- Active runs are listed before a restart and require confirmation. `--force`
  bypasses it; without a terminal, the command otherwise refuses.
- A failed step prints `FAIL <step>` and a repair. Fix it, then run `up` again.

## Upgrading jigs

`jigs upgrade` moves the factory's jigs pin to the latest release, or to
`--to-version <version>`. Then, using the newly installed version, it
regenerates `jigs/`, runs `jigs up` and runs the factory's typecheck. Review
and commit the changes it makes. Your workflows and copied recipes are yours to
update: a new release can change an API they use, and the typecheck tells you
where.

## Cancelling

`jigs cancel` ends a waiting run immediately, and asks first when the run is in
the middle of a step (`--force` skips the question). A step already running may
still finish its outside work, but the run does not continue. Cancel lists any
worktrees it leaves behind.

## Cleaning up resources

Resource cleanup is conservative. jigs removes only finished-run resources it
can prove it owns and can safely remove. `jigs resources prune` previews unless
you add `--apply`. To apply:

1. Run `jigs service stop`.
2. Check the preview, optionally for one run with `--run <run>`.
3. Run `jigs resources prune --apply`.

Only resources of finished runs owned by this factory are removed. A worktree
with uncommitted changes, an unmerged branch, a waiting run's resources and
anything jigs cannot prove it owns are always kept. Resources a release policy
chose to keep need `--include-kept`, which relaxes nothing else.

Applying works on macOS and Linux. It never stops or kills anything itself: it
refuses, and tells you to run `jigs service stop`, while the service or any
process it started is still running.
