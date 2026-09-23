# Run your first workflow

This guide gets a new factory running and launches `hello`, the workflow included
with every new factory. It does not call a model or change a repository.

## 1. Check your machine

Have these ready before you begin:

- Node.js 24 or newer and pnpm.
- Docker with its daemon running.
- For workflows that run agents, the CLI of each harness they require, such as
  Claude Code (`claude`) or Codex (`codex`), on your shell’s `PATH` and logged in.
  `hello` runs no agent and needs none.

If you use a Node version manager, start the service from a shell where Node and
those CLIs work.

## 2. Create your factory

```sh
mkdir my-factory
cd my-factory
git init
pnpm dlx @jigs-ai/jigs init
```

The command writes your starting files and prints the next steps. It does not
start services. The service and database ports are chosen for your factory;
use the values it prints.

Open `workflows/hello.ts`. It creates a scratch directory for a run, removes it,
and returns the message you supply. `jigs.config.ts` registers that workflow under
the name `hello`.

## 3. Start the service

```sh
cp .env.example .env
pnpm install
pnpm exec jigs up
```

`up` prepares dependencies and Postgres, builds your factory, and starts its
service. Wait for it to report ready.

The last step runs `jigs doctor`, which checks only what your workflows require
and what `jigs.config.ts` turns on. `hello` needs no Linear or GitHub credentials
and no agent CLI; your package token is still needed for installation.

## 4. Launch and inspect a run

```sh
pnpm exec jigs run hello --input message=hello
pnpm exec jigs status
```

The launch reports a run ID. Inspect that run by substituting its ID below:

```sh
pnpm exec jigs status <run-id>
```

The run should complete successfully. You can also open the dashboard at the
dashboard port in your factory’s configuration and inspect its recorded steps.

## Next steps

Read [core concepts](./concepts) before editing your workflow. Then choose
[an agent call](./agents), [a model call](./models), or the [ship recipe](./ship).
For GitHub identities and other credentials, follow the
[full setup runbook](https://github.com/salimhamed/jigs/blob/main/docs/setup.md).
A factory needs no webhooks: parked runs re-read GitHub and Linear every 300
seconds by default. Webhooks are optional, to react faster; the runbook's step
5 turns them on per provider.
