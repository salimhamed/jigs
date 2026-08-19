# Issue tracker: Linear

Issues and specs for this repo live in Linear, in the **Jigs** project under the
**Development** team (key `AGE`). Use the `linear-personal` MCP server tools for
all operations.

- **Project**: Jigs — https://linear.app/salboogie/project/jigs-6fb1b24b31d3
  (id `cba18af1-71f0-4a08-bdec-24b5c88b1ec9`)
- **Team**: Development (key `AGE`, id `1a7c511f-7779-4da3-ba3b-71d8943e8471`)

## Conventions

- **Create an issue**: `save_issue` with team `Development` and project `Jigs`.
- **Read an issue**: `get_issue` with the `AGE-<n>` identifier; `list_comments` for discussion.
- **List issues**: `list_issues` filtered by `project: Jigs` plus state/label filters.
- **Comment**: `save_comment` on the issue.
- **Apply / remove labels**: pass `labels` to `save_issue`; create missing team labels with `create_issue_label`.
- **Close**: `save_issue` setting state to `Done` (or `Canceled` for wontfix).

## When a skill says "publish to the issue tracker"

Create a Linear issue in the Jigs project.

## When a skill says "fetch the relevant ticket"

`get_issue` with the `AGE-<n>` identifier.

## Wayfinding operations

Used by `/wayfinder`.

- **Map**: a single issue labelled `wayfinder:map` holding the Notes / Decisions-so-far / Fog body.
- **Child ticket**: a Linear sub-issue of the map (`save_issue` with `parent`), labelled `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, assign to the driving dev.
- **Blocking**: Linear's native "blocked by" issue relations. A ticket is unblocked when every blocker is Done.
- **Frontier query**: `list_issues` for the map's open children, drop any with an open blocker or an assignee; first in map order wins.
- **Claim**: assign the issue to yourself (`save_issue` with `assignee: me`).
- **Resolve**: `save_comment` with the answer, mark Done, append a context pointer to the map's Decisions-so-far.
