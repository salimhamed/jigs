# Install and run a first workflow

This guide creates a factory, starts its service and runs `hello`, the workflow
every new factory includes. `hello` calls no model and changes no repository,
so you need no credentials to try it.

## Set up with your agent

If you use a coding agent, you can let it do the steps below. Install the jigs
skill, then ask your agent to set up a factory:

```sh
npx skills add salimhamed/jigs
```

For example: "Use /jigs to set up a jigs factory in this empty directory." The
rest of this page is the same process by hand.

## 1. Check your machine

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
  running after you log out.

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
cp .env.example .env
pnpm install
pnpm exec jigs up
```

`jigs up` installs dependencies, starts Postgres, builds the factory, starts the
service and waits until it is ready. Its last step runs `jigs doctor`, which
checks only what your workflows use. You can run `pnpm exec jigs doctor` again
at any time while the service is running.

The final line looks like this:

```
my-factory-2286ac2a is up at http://localhost:8990 — dashboard http://localhost:9090
```

Open the dashboard URL from your own output. It shows every run and its steps.

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
[Build a workflow](/guide/build-a-workflow), or see
[Configuration](/guide/configuration) to connect GitHub and Linear.
