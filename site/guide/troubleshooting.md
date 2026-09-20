# Troubleshooting

Start with the command that failed: jigs usually prints the failed check and a
repair instruction. For service startup problems, these commands give the most
useful next evidence:

```sh
pnpm exec jigs service status
pnpm exec jigs service logs
```

Once integrations are configured, run `pnpm exec jigs doctor` to check the factory.

## Installation says unauthorized or forbidden

Check your user-level `~/.npmrc`: it must route `@salimhamed` to
`https://npm.pkg.github.com` and contain a valid classic token with `read:packages`.
The token’s GitHub account must have access to the package. Source visibility and
package access are separate; a public repository alone does not grant installation
access. Do not paste tokens into logs or commit them to your factory.

## The service exits before becoming ready

Read `service logs`. Confirm Docker is running and both `claude` and `codex` are
available in the shell that starts the service. Authenticate both tools. If the
log names a minimum Codex version, update the installed Codex CLI.

## Hello works, but doctor reports GitHub credentials

The full doctor pass checks GitHub credentials even for a factory only running
`hello`. Use `pnpm exec jigs up --no-doctor` for the introductory setup. Configure
integrations before running a workflow that needs them; this flag does not remove
that workflow’s requirements.

## A build says generated integration is stale

Run `pnpm exec jigs generate`, review the changes to `jigs.ts`, and then run
`pnpm exec jigs up`. Keep custom code outside `jigs.ts` so regeneration can safely
replace it. `jigs upgrade` handles regeneration when you update the package.

## A workflow is waiting

Run `pnpm exec jigs status <run-id>`. A suspension is an expected wait, such as a
human question or outstanding pull-request review. Follow the reported link and
resolve the condition. Starting another run does not answer the existing one.

If you have answered but the run remains waiting, inspect webhook configuration
and service logs using the [setup runbook](https://github.com/salimhamed/jigs/blob/main/docs/setup.md).
A notification asks the run to recheck its condition; it cannot substitute for
the required answer or approval.

## An old working directory remains

This can be intentional: failed runs, waiting runs, and unfinished Git work may
be retained. Inspect `pnpm exec jigs resources list` and preview
`pnpm exec jigs resources prune` before removing anything. The
[resource release guide](https://github.com/salimhamed/jigs/blob/main/docs/automatic-resource-release.md)
explains what is eligible.
