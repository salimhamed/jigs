# Conventional PR titles, and release-please cuts the release

Versions move on their own from here. A PR title is a conventional commit —
`.github/workflows/pr-title.yml` fails the PR when it is not — and every squash
onto `main` runs release-please, which keeps one open release PR carrying the
next version, the CHANGELOG entries earned since the last release, and nothing
else. That PR waits on its own `ci` and `step-ids` runs and then merges itself;
the merge re-runs release-please, which writes the tags and the GitHub
Releases. Nobody edits a `version` field by hand, and nobody decides whether a
change was a patch or a minor — the titles already said.

**This is only safe because of [ADR 0013](./0013-factory-owned-steps.md).**
While a jigs version was baked into every step id, a release renamed every
memoization key in every factory at once, which is why the version was pinned
at `0.0.0` and why automating it would have been automating a footgun. Step ids
are factory-local paths now (`step//./steps/jigs//worktree`), nothing reads
either package's version at runtime, and a factory pins both to one published
version. The number is a signal to a reader and a coordinate for `pnpm update`,
so the cost of getting one wrong is a reader being told the wrong thing — small
enough that a machine should be the one choosing it.

**The two packages release in lockstep**, through release-please's
`linked-versions` plugin with both components in one group. They are one
library split for packaging reasons, a factory installs both at the same
version, and two independently drifting numbers would answer a question nobody
asks. One release PR covers both; a release with no commits of its own still
bumps the quiet package to keep the pair readable as a single number.

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
  not its merge subject: `squashMerge` reads the PR's current title back from
  GitHub at merge time, so the edit that turned a rejected title into a
  releasable one is what lands on `main`. A title captured when the PR opened
  would quietly ship the version the reviewer corrected away, and the release
  it should have cut would simply not happen.
- **The repo must squash-merge with the PR title as the commit subject.**
  Settings → General → "Default to PR title for squash merge commits". Without
  it the subject is the branch name, every merge parses as a non-releasable
  unit, and the release PR simply never appears — no error anywhere.
- **`group-pull-request-title-pattern` is load-bearing, not cosmetic.** It is
  set to `chore${scope}: release jigs libraries`, which is exactly what the
  `linked-versions` plugin hardcodes when it *creates* the PR. The default
  pattern is what release-please uses to *parse* its own merged PR on the next
  run, and the two do not match — leaving it unset gets a working first release
  and then `Bad pull request title` forever
  ([release-please#2306](https://github.com/googleapis/release-please/issues/2306)).
- **The merge step polls, because `--auto` cannot work here.** GitHub offers
  auto-merge only on a PR that cannot merge immediately, which means a branch
  protection rule with required checks. `main` has none, so the release PR is
  mergeable the moment it exists and `gh pr merge --auto` exits non-zero. The
  workflow waits with `gh pr checks --watch --fail-fast` and then merges
  outright — the same wait, spelled out. If `main` ever grows protection with
  `ci` and `step-ids` required, this becomes a one-line change.
- **The merge step names the checks it is waiting for.** `--watch` waits on
  the checks already in the PR's rollup and has no notion of one that has not
  been created yet; check runs enter the rollup as their workflow runs are
  created, not atomically across workflows. A rollup holding only a finished
  `pr-title` therefore reads as green, and the merge fires with `ci` and
  `step-ids` never having run. So the step first polls until every name in
  `EXPECTED_CHECKS` (`ci`, `step-ids`, `pr-title`) is registered, and only then
  watches — which also covers the empty rollup `gh pr checks` fails outright
  on. The cost is a list that must track the job ids in `.github/workflows/`:
  a job added there and not here is a check the release PR can merge past.
- **The `gh` calls need `GH_REPO`.** Nothing is checked out in that job —
  `release-please-action` only talks to the API — and `gh` resolves the
  repository from `--repo`, then `GH_REPO`, then the working directory's git
  remote. It never reads the runner's `GITHUB_REPOSITORY`, so without
  `GH_REPO` every call aborts on "not a git repository" before reaching the
  network.
- **Two tags and two Releases per version**, `jigs-vX.Y.Z` and
  `service-vX.Y.Z`. A single shared `vX.Y.Z` needs a root package to hang the
  tag on and `skip-github-release` on both children; the root `package.json`
  has no version and must not grow one, since it is not a released thing.
- **The run that cuts the Releases also publishes both packages** to GitHub
  Packages as `@salimhamed/jigs` and `@salimhamed/jigs-service` (`restricted`:
  the repo is private, and so is the registry entry). release-please itself
  publishes nothing — the `node` strategy only rewrites `package.json` and the
  CHANGELOGs — so a `publish` job runs after it, gated on `releases_created`,
  and skips a version the registry already holds so a re-run of the workflow
  is idempotent rather than a conflict. No provenance attestation: npm only
  issues those on the public registry. A factory upgrades by moving both pins
  and running `jigs up`; a consumer needs a token with `read:packages` in
  `~/.npmrc`, and the scaffolded `.npmrc` carries only the scope-to-registry
  line.

## Considered options

- **Keep bumping versions by hand.** The status quo, and it survives exactly as
  long as someone remembers. A version nobody reads at runtime is a version
  nobody notices is stale, and the first thing a stale one costs is the trust
  that made it worth writing down.
- **Changesets.** A better fit when humans want to write release notes and
  batch several PRs into one version deliberately. Rejected for the opposite
  reason it is usually chosen: it adds a file to every PR, and the intent it
  captures is already in the title this repo enforces anyway.
- **Separate release PRs per package** (`separate-pull-requests: true`).
  Rejected with lockstep — two PRs, two merges and two versions for one
  library, and the pair's whole value is being one number.
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
- **A release and its publish are two steps that can come apart.** The tags
  and Releases exist before the publish job runs, so a failed publish leaves a
  version that is tagged but not installable. Re-running the workflow is the
  repair: the job skips what already landed and publishes the rest.
- **The quiet package gets near-empty changelog entries.** Lockstep bumps it
  through a synthetic `Release-As:` commit, so `packages/service/CHANGELOG.md`
  will carry versions whose only note is the synchronization. That is the
  shape of lockstep, not a bug to fix.
- **The merge step's expected-checks list is a second copy of the job ids.**
  There is no "wait for the checks to exist" flag, so the wait has to name
  what it is waiting for, and nothing enforces that the list and
  `.github/workflows/` agree. A stale name fails the release loudly after five
  minutes of polling — the release PR is left open and unmerged, recoverable
  by hand and the direction this fails in. A *missing* name is the quiet one:
  the merge no longer waits on that check. Adding a CI job means adding it
  here.
