# Troubleshooting

Start with the command that failed: jigs usually prints the failed check and a
repair instruction. For service startup problems, these commands give the most
useful next evidence:

```sh
pnpm exec jigs service status
pnpm exec jigs service logs
```

Once integrations are configured, run `pnpm exec jigs doctor` to check the factory.

## The service exits before becoming ready

Read `service logs`. Confirm Docker is running and that each agent CLI the log
names is available, and logged in, in the shell that starts the service. The log
says which workflows need it. If the log names a minimum Codex version, update
the installed Codex CLI.

## Doctor reports a credential for a workflow you have not run

Doctor checks every integration a registered workflow's `requires` names, and
each failure says which workflows need it. Configure the credential, or remove
the workflow from `jigs.config.ts` if the factory does not use it.

## A build says generated integration is stale

Run `pnpm exec jigs generate`, review the changes to `jigs.ts`, and then run
`pnpm exec jigs up`. Keep custom code outside `jigs.ts` so regeneration can safely
replace it. `jigs upgrade` handles regeneration when you update the package.

## A workflow is waiting

Run `pnpm exec jigs status <run-id>`. A suspension is an expected wait, such as a
human question or outstanding pull-request review. Follow the reported link and
resolve the condition. Starting another run does not answer the existing one.

If you have answered but the run remains waiting, it notices on the next poll,
within `service.pollIntervalSeconds` (300 seconds by default), or sooner with
webhooks on. `pnpm exec jigs poke <run-id>` wakes it now. If it still waits,
read the service's `[nudge]` log lines and, with webhooks on, the webhook
configuration, using the [setup runbook](https://github.com/salimhamed/jigs/blob/main/docs/setup.md).
A wake asks the run to recheck its condition; it cannot substitute for the
required answer or approval.

With GitHub webhooks on, if `pnpm exec jigs doctor` reports that the factory rejected a repo's webhook
deliveries with 401, GitHub's copy of the secret does not match
`GITHUB_WEBHOOK_SECRET` in `.env`. Run `pnpm exec jigs bind <remote>` to send
GitHub the current value.

## An old working directory remains

This can be intentional: failed runs, waiting runs, and unfinished Git work may
be retained. Inspect `pnpm exec jigs resources list` and preview
`pnpm exec jigs resources prune` before removing anything. The
[resource release guide](https://github.com/salimhamed/jigs/blob/main/docs/automatic-resource-release.md)
explains what is eligible.
