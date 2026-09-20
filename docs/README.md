# jigs documentation

## Guides

- [Setup and operation](setup.md)
- [Authoring bespoke workflows](bespoke-workflows-plan.md)
- [Ship recipe](delivery.md)
- [Automatic resource release](automatic-resource-release.md)
- [Long-step regression](long-step-regression.md)

## API reference

- [Package root](api/index.md)
- [`blocks/` and `steps/` import paths](api/)

The API reference is generated from the package exports and describes the latest
published version. Run `pnpm docs` for a local preview.

## Architecture decisions

- [0004 — CLI providers drive harnesses](adr/0004-cli-providers-drive-harnesses.md)
- [0006 — Bindings in factory config](adr/0006-bindings-in-factory-config.md)
- [0007 — Worktree lifecycle](adr/0007-worktree-lifecycle.md)
- [0008 — Adopt Workflow SDK runtime](adr/0008-adopt-workflow-sdk-runtime.md)
- [0009 — Webhook ingress and resource-scoped tokens](adr/0009-webhook-ingress-resource-scoped-tokens.md)
- [0010 — Preflight in the trigger path](adr/0010-preflight-in-trigger-path.md)
- [0011 — MCP denied by default](adr/0011-mcp-deny-by-default.md)
- [0013 — Factory-owned steps](adr/0013-factory-owned-steps.md)
- [0014 — Release automation](adr/0014-release-automation.md)
- [0017 — Single package](adr/0017-single-package.md)
- [0019 — Layout by code kind](adr/0019-layout-by-code-kind.md)
- [0020 — Blocks, recipes and run resources](adr/0020-blocks-recipes-and-run-resources.md)
- [0021 — GitHub account installations](adr/0021-github-account-installations.md)
- [0022 — Ticket status is workflow policy](adr/0022-ticket-status-is-workflow-policy.md)
