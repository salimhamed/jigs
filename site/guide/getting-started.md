# Install and run a first workflow

This guide creates a factory, starts its service and runs `hello`, the workflow
every new factory includes. `hello` calls no model and changes no repository,
so you need no credentials to try it.

## Set up with your agent

If you use a coding agent, you can let it do the steps below. Install the jigs
skill, which adds a single skill named `/jigs`:

```sh
npx skills add salimhamed/jigs
```

Then ask your agent `/jigs set up a factory in this empty directory`.

The rest of this page is the same process by hand.

## 1. Host dependencies

- **Node.js 24 or newer** and **pnpm**.
- **Docker**, with its daemon running. Each factory runs its own Postgres
  container.
- **Agent CLIs, only for the harnesses your workflows use.** `hello` uses none.
  Install each one yourself, keep it on the `PATH` of the shell that starts the
  service, and log in:

  | Harness | Command | Log in |
  | --- | --- | --- |
  | Claude Code | `claude` | `claude auth login` |
  | Codex | `codex` | `codex login` |
  | Pi | `pi` | run `pi`, then `/login` |

- **On Linux**, run `loginctl enable-linger "$USER"` once, so the service keeps
  running after you log out. On a host without systemd, such as macOS, the
  service runs unsupervised and stops when you log out.

jigs installs from public npm as `@jigs-ai/jigs`. Each factory pins its own
version, so there is nothing to install globally and no registry token.

## 2. Create a factory

```sh
mkdir my-factory
cd my-factory
git init
pnpm dlx @jigs-ai/jigs init
```

`init` writes the starting files and prints the next steps with this factory's
ports filled in. It does not start anything. `workflows/hello.ts` is the first
workflow, and `jigs.config.ts` registers it under the name `hello`.

## 3. Start the service

```sh
pnpm install
cp .env.example .env
pnpm exec jigs up
```

`pnpm install` puts this factory's jigs in place for `pnpm exec`. `hello`
needs nothing filled in `.env`. `jigs up` starts Postgres, builds the factory,
starts the service and waits until it is ready. It then runs `jigs doctor`,
which checks only what your workflows use; rerun it any time with
`pnpm exec jigs doctor`.

It ends by naming the two things it runs, one Postgres container and one service
process that also serves the dashboard, and how to stop each:

```
my-factory-2286ac2a is up
  postgres   docker compose project my-factory, port 5440    stop: docker compose down
  service    http://localhost:8990  pid 53812                stop: pnpm exec jigs service stop
             dashboard http://localhost:9090                 logs ~/.local/share/jigs/services/my-factory-2286ac2a.log
  stop everything: pnpm exec jigs down
```

Open the dashboard URL from your own output. It shows every run and its steps.
`pnpm exec jigs service stop` stops the service and its dashboard and leaves
Postgres running; `pnpm exec jigs down` stops both and keeps Postgres's data.

## 4. Run hello

```sh
pnpm exec jigs run hello --input message=hello
pnpm exec jigs status
```

`run` prints the new run's ID and its dashboard link. `status` lists runs; pass
a run ID to see one run in detail:

```sh
pnpm exec jigs status <run-id>
```

The run should finish as completed. From here, write your own workflow with
[Build a workflow](/guide/build-a-workflow). Binding a repository needs GitHub
credentials, so set them first: see
[GitHub identity](/guide/configuration#github-identity).
