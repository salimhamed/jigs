# Run and monitor workflows

Run commands inside your factory repository. `pnpm exec jigs` uses that factory’s
installed version of jigs.

## Find and launch a workflow

```sh
pnpm exec jigs workflows
pnpm exec jigs run hello --input message=hello
```

`workflows` lists the names registered in the running service and their input
metadata. Each launch creates a run that survives the terminal used to start it.

## See progress

```sh
pnpm exec jigs status
pnpm exec jigs status <run-id>
pnpm exec jigs watch <run-id>
```

`status` gives a snapshot. `watch` follows activity until you stop watching; omit
the run ID to follow all runs. A full run ID or a unique prefix works. Workflows
that claim a ticket can also be selected by its ticket identifier.

For waiting runs, status tells you what they need and where to act. Detailed
status for a pull-request wait also checks GitHub for current review, CI, and
merge conditions. The dashboard on your factory’s dashboard port shows the
recorded step history.

## Apply factory changes

```sh
pnpm exec jigs up
```

Use `up` after changing configuration or workflow code. It brings dependencies,
Postgres, the build, and the running service into agreement. For the bare hello
setup without integration credentials, continue using `up --no-doctor`.

Before deploying incompatible workflow changes, finish or deliberately cancel
affected active runs. See [core concepts](./concepts#changing-a-running-workflow).

## Upgrade jigs

```sh
pnpm exec jigs upgrade
```

This updates the package, regenerates `jigs.ts`, brings the factory up, and
typechecks it. Review and commit the resulting changes. Your custom workflow and
copied recipe code remain yours to maintain.

## Inspect retained resources

```sh
pnpm exec jigs resources list
pnpm exec jigs resources prune
```

The second command previews eligible removals. Inspect that preview before
choosing `pnpm exec jigs resources prune --apply`.

By default, terminal successful runs release eligible managed local resources;
failed or cancelled runs retain them. Suspended runs retain their resources too.
Factory and workflow policies can change the terminal-run defaults. See the
[resource release guide](https://github.com/salimhamed/jigs/blob/main/docs/automatic-resource-release.md)
for the rules that protect unfinished work.
