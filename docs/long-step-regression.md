# Long step regression

The normal E2E check uses a short delay so pull requests stay quick. The
on-demand long step regression runs the same compiled-runtime fixture with a
301-second step against disposable Postgres. It proves that the step completes
once, the transport does not deliver it again after five minutes, and the
workflow continues through its later parallel steps, resource updates, sleep,
restart recovery, and hook resume.

Run it locally when changing the Workflow SDK, Postgres World, service startup,
or delivery and transport code. Docker must be available:

```sh
docker run --detach --rm \
  --name jigs-age-488-postgres \
  --publish 127.0.0.1:55490:5432 \
  --env POSTGRES_USER=jigs \
  --env POSTGRES_PASSWORD=jigs \
  --env POSTGRES_DB=jigs \
  postgres:17-alpine
trap 'docker stop jigs-age-488-postgres >/dev/null' EXIT
until docker exec jigs-age-488-postgres pg_isready -U jigs -d jigs >/dev/null 2>&1; do sleep 1; done
JIGS_E2E_LONG_STEP_MS=301000 \
  WORKFLOW_POSTGRES_URL=postgres://jigs:jigs@127.0.0.1:55490/jigs \
  pnpm e2e
```

The test takes at least five minutes plus build and startup time. The command
must be run once with the real `301000` value for an upgrade or transport
change; a short delay or fake timer is not equivalent. The output records the
compiled run's completion. The harness also validates that its internal marker
list contains exactly one `start long` and `end long` pair before the
subsequent progress.

The GitHub Actions workflow is dispatch-only, so it becomes available after
the workflow file is merged on the repository's default branch. In the Actions
UI, choose **Long step regression**, select **Run workflow**, and enter the
commit, branch, or tag to test in **revision**. The run checks out that exact
revision and writes its resolved commit and installed Workflow SDK versions to
the job summary.

An agent can launch the same check after the workflow is present on `main`:

```sh
gh workflow run long-step-regression.yml \
  --repo salimhamed/jigs \
  --ref main \
  --field revision=0123456789abcdef0123456789abcdef01234567
gh run watch --repo salimhamed/jigs --exit-status
```

`--ref main` selects the default-branch copy of the workflow; the `revision`
field selects the source revision under test. Use a full commit SHA when the
result must be tied to an immutable source. The run's summary is the evidence
to retain with the upgrade review.

Do not add this invocation to pull request, push, scheduled, or required-check
triggers. It is an explicit human or agent checklist before adopting SDK
upgrades and after execution or transport changes. Do not restore a global HTTP
dispatcher or other blanket timeout override to make the test pass.
