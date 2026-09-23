# Conventional PR titles, and release-please cuts the release

Status: accepted

A PR title is a conventional commit, enforced by `.github/workflows/pr-title.yml`.
Every squash onto `main` runs release-please, which keeps one open release PR
carrying the next version and its CHANGELOG. GitHub auto-merges that PR once
its required `ci`, `step-ids` and `pr-title` checks pass; the merge re-runs
release-please, which writes the tag and the GitHub Release, and a `publish`
job then publishes to npm. Nobody edits a version by hand.

This is safe only because step ids are factory-local paths
([0006](./0006-factory-owned-steps.md)): a release no longer renames every
factory's memoization keys.

The repository root is the only release-please package, component `jigs`, so a
version is one release PR, one `jigs-vX.Y.Z` tag and Release, and one publish
of `@jigs-ai/jigs`.

## Consequences

- **A PR title is release input.** Below 1.0.0, `feat:` and `fix:` are patches,
  `feat!:` is a minor, and anything else releases nothing. The title check
  re-runs on `edited`, so fixing a title needs no push. `mergePullRequest`
  reads the title back at merge time, so a corrected title is what lands.
- **The repository must squash-merge with the PR title as the subject**
  ("Default to PR title for squash merge commits"). Otherwise the release PR
  silently never appears.
- **release-please and the auto-merge step authenticate with
  `RELEASE_PLEASE_TOKEN`, never `GITHUB_TOKEN`.** GitHub raises no workflow run
  for events caused by `GITHUB_TOKEN`, so the release PR would get no checks
  and the merge would never re-run release-please.
- **Publishing uses npm trusted publishing.** The job's `id-token: write`
  grant is the whole credential, npm attaches provenance, and the job uses
  `npm publish` (npm 11.5.1 or later) because trusted publishing needs it.
  `repository.url` in `package.json` must name this repository exactly.
- **`group-pull-request-title-pattern` is load-bearing.** release-please writes
  the release PR title with `chore${scope}: release jigs` and parses its own
  merged PR with the same string; changing it breaks the next release.
- **The `gh` calls need `GH_REPO`**, because that job checks nothing out.
- **Publish is idempotent and checks out the tag.** It skips a version the
  registry already holds and refuses to publish unless the checked-out version
  matches the tag, so re-running the workflow repairs a failed publish without
  shipping an older checkout.
- The release branch regenerates the committed API reference, and `ci` fails a
  release PR whose reference differs from a fresh generation.
- Required-check names are repository ruleset configuration: renaming a
  required job means updating the ruleset. The PAT expires; a token that can
  open but not merge leaves the release PR open, which looks like no release.
