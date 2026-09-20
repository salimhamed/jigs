# Conventional PR titles, and release-please cuts the release

Versions move on their own from here. A PR title is a conventional commit —
`.github/workflows/pr-title.yml` fails the PR when it is not — and every squash
onto `main` runs release-please, which keeps one open release PR carrying the
next version, the CHANGELOG entries earned since the last release, and nothing
else. GitHub auto-merges that PR after its required `ci`, `step-ids`, and
`pr-title` checks pass on the current commit;
the merge re-runs release-please, which writes the tags and the GitHub
Releases. Nobody edits a `version` field by hand, and nobody decides whether a
change was a patch or a minor — the titles already said.

**This is only safe because of [ADR 0013](./0013-factory-owned-steps.md).**
While a jigs version was baked into every step id, a release renamed every
memoization key in every factory at once, which is why the version was pinned
at `0.0.0` and why automating it would have been automating a footgun. Step ids
are factory-local paths now (`step//./jigs//provisionWorktree`). The factory
pins the one published jigs package; the number is its update coordinate.

**One component, one number.** The repository root is the only release-please
package, with component `jigs`, so a version is one release PR, one tag and
Release (`jigs-vX.Y.Z`), and one publish (ADR 0017). The release workflow reads
the unprefixed root-package `tag_name` output.

**Both the action and the merge step authenticate as a PAT
(`RELEASE_PLEASE_TOKEN`), never `GITHUB_TOKEN`.** GitHub raises no workflow run
for an event caused by `GITHUB_TOKEN`, and that rule bites this design twice.
The release PR would get no `ci`, `step-ids` or `pr-title` runs, so the merge
step would watch a PR with no checks on it; and the squash back onto `main`
would raise no `push`, so release-please would never run again and the tags and
Releases would never be cut. The PR merges and nothing ships — a silent
failure, and the reason the token appears in both steps.

**The publish job authenticates as `GITHUB_TOKEN`, never the PAT.** The
anti-loop rule that forces the PAT above does not apply to a publish: nothing
downstream waits on an event it raises. What a publish needs is a write to this
repo's GitHub Packages, and the workflow's `packages: write` grant is exactly
that and nothing more — a PAT would carry `write:packages` across every
repository the human can reach, sitting in a secret for the one job that does
not need it. Each `package.json` names the repository, which is how GitHub
Packages links the package to it and lets the repo-scoped token publish.

## Consequences

- **A PR title is release input, not a label.** `feat:` and `fix:` are both a
  patch below 1.0.0 (`bump-patch-for-minor-pre-major`), `feat!:` is a minor
  (`bump-minor-pre-major`), and anything else releases nothing. The check that
  enforces the grammar runs on `pull_request`, so it reports against the PR's
  head commit where `gh pr checks --watch` can see it, and re-runs on `edited`
  — fixing a rejected title is enough, with no push.
- **A PR jigs opened complies through `describePr`, and a corrected one still
  wins.** The title a factory's `describePr` writes is the PR's opening title,
  not its merge subject: `mergePullRequest` reads the PR's current title back from
  GitHub at merge time, so the edit that turned a rejected title into a
  releasable one is what lands on `main`. A title captured when the PR opened
  would quietly ship the version the reviewer corrected away, and the release
  it should have cut would simply not happen.
- **The repo must squash-merge with the PR title as the commit subject.**
  Settings → General → "Default to PR title for squash merge commits". Without
  it the subject is the branch name, every merge parses as a non-releasable
  unit, and the release PR simply never appears — no error anywhere.
- **`group-pull-request-title-pattern` is load-bearing, not cosmetic.** It is
  set to `chore${scope}: release jigs`, and the same string has to serve twice:
  release-please writes the PR title with it and then *parses* its own merged
  PR with it on the next run. Leaving it unset, or changing it between those
  two moments, gets a working first release and then `Bad pull request title`
  forever
  ([release-please#2306](https://github.com/googleapis/release-please/issues/2306)).
- **GitHub owns the merge gate.** The default-branch ruleset requires `ci`,
  `step-ids`, and `pr-title` from GitHub Actions, and repository auto-merge is
  enabled. The release workflow requests `gh pr merge --auto --squash` with
  the PAT, then exits. GitHub waits for the current commit's required checks.
  A generated-docs commit must pass its own checks before merging. Delayed
  check registration no longer runs into a shell polling deadline, and no
  script can accidentally merge a newer head after watching older checks.
- **The `gh` calls need `GH_REPO`.** Nothing is checked out in that job —
  `release-please-action` only talks to the API — and `gh` resolves the
  repository from `--repo`, then `GH_REPO`, then the working directory's git
  remote. It never reads the runner's `GITHUB_REPOSITORY`, so without
  `GH_REPO` every call aborts on "not a git repository" before reaching the
  network.
- **The tag is the component's, not the repo's**: `jigs-vX.Y.Z`. A bare
  `vX.Y.Z` needs a root package to hang the tag on, and the root
  `package.json` has no version and must not grow one, since it is not a
  released thing.
- **The run that cuts the Release also publishes the package** to GitHub
  Packages as `@salimhamed/jigs` (`restricted`: the repo is private, and so is
  the registry entry). release-please itself
  publishes nothing — the `node` strategy only rewrites `package.json` and the
  CHANGELOGs — so a `publish` job runs after it, gated on `releases_created`,
  and skips a version the registry already holds so a re-run of the workflow
  is idempotent rather than a conflict. No provenance attestation: npm only
  issues those on the public registry. A factory upgrades with `jigs upgrade`
  (the pin, then `jigs up`, then its typecheck); a consumer needs a token
  with `read:packages` in `~/.npmrc`, and the scaffolded `.npmrc` carries only
  the scope-to-registry line. The dependency shape and the consumer side are
  [ADR 0017](./0017-single-package.md).
- **The release branch owns generated API reference updates.** Once
  release-please writes the bumped version, a branch-only `api-docs` job
  generates and commits `docs/api` with the same PAT. The follow-up branch push
  reruns the PR checks; generating no diff succeeds without another commit.
  For release PRs, `ci` regenerates the reference and fails if the committed
  files differ, including added or removed pages. A successful generation job
  on an older commit therefore cannot unlock a merge. The branch-only
  `api-docs` job is not a required check: ordinary PRs do not run it.
  Workflow concurrency is scoped by ref: main pushes still
  serialize, while the release-branch job can generate documentation
  independently of release-please updating the PR.

## Considered options

- **Keep bumping versions by hand.** The status quo, and it survives exactly as
  long as someone remembers. A version nobody reads at runtime is a version
  nobody notices is stale, and the first thing a stale one costs is the trust
  that made it worth writing down.
- **Changesets.** A better fit when humans want to write release notes and
  batch several PRs into one version deliberately. Rejected for the opposite
  reason it is usually chosen: it adds a file to every PR, and the intent it
  captures is already in the title this repo enforces anyway.
- **Batch releases behind a label or `workflow_dispatch`** instead of merging
  on `prs_created`. A real option later: `prs_created` is true when the release
  PR is *updated*, not only created, so today every releasable merge to `main`
  ships. Rejected for now because this repo is its own only consumer, so a
  release costs nothing and a fast one is easier to reason about than a queue.

## Known costs, accepted with eyes open

- **The PAT is a human's credential with an expiry.** When it lapses the
  release workflow fails loudly on the action, but a *narrower* failure is
  quieter: a token that can still open the PR but not merge it leaves the
  release PR sitting open, which looks like "no release was due".
- **A release and its publish are two steps that can come apart.** The tag and
  Release exist before the publish job runs, so a failed publish leaves a
  version that is tagged but not installable. Re-running the workflow is the
  repair: the job skips what already landed and publishes the rest. To make
  that honest, the publish job checks out the released tag rather than the
  commit that triggered the run, and verifies the version is on the registry
  before it exits — release-please decides from GitHub's state, so a run
  triggered by an earlier push could cut the tag and then build the *older*
  checkout, whose version the registry already held, which the idempotent skip
  reported as success while 0.4.2 never shipped. Main's ref-scoped `concurrency`
  group keeps overlapping pushes from racing at all.
- **Required-check names are repository configuration.** Renaming a required
  job means updating the default-branch ruleset too. Missing or failed checks
  leave auto-merge pending; they do not permit an unchecked merge. Only checks
  reported for every PR belong in that ruleset.
