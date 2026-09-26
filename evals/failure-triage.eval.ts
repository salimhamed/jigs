import { failureTriage } from "../recipes/linear-ticket-to-pr/decisions.ts";
import { evalSite } from "./harness.ts";

const failed = (phase: string, name: string, message: string, hint: string | null = null) => ({
  phase,
  attempt: 1,
  name,
  message,
  hint,
});
// How a step's error reaches the workflow once its own retries are spent.
const exhausted = (phase: string, step: string, message: string) =>
  failed(
    phase,
    "FatalError",
    `Step "step//./jigs/steps//${step}" failed after 3 retries: ${message}`,
  );

evalSite("failure-triage", {
  question: failureTriage,
  cutoff: 0.9,
  cases: [
    {
      name: "GitHub 502 through every retry",
      state: exhausted("publish", "openPullRequest", "GitHub API responded 502 Bad Gateway"),
      expected: "outage",
    },
    {
      name: "socket reset through every retry",
      state: exhausted("follow the pull request", "fetchPullRequestState", "read ECONNRESET"),
      expected: "outage",
    },
    {
      name: "rate limited through every retry",
      state: exhausted(
        "implement and review",
        "executeAgent",
        "429 Too Many Requests: rate limit exceeded, retry after 30s",
      ),
      expected: "outage",
    },
    {
      name: "token lacks permission",
      state: exhausted(
        "publish",
        "pushApprovedChange",
        "GitHub rejected the push: Resource not accessible by integration",
      ),
      expected: "needs-human",
    },
    {
      name: "harness not installed",
      state: failed(
        "implement and review",
        "JigsError",
        "codex is not installed",
        "npm install --global @openai/codex",
      ),
      expected: "needs-human",
    },
    {
      name: "undefined property",
      state: failed(
        "publish",
        "TypeError",
        "Cannot read properties of undefined (reading 'headSha')",
      ),
      expected: "bug",
    },
    {
      name: "invariant broken",
      state: failed(
        "follow the pull request",
        "JigsError",
        "the pull request watch for acme/app#7 ended without a close",
      ),
      expected: "bug",
    },
    {
      name: "branch deleted",
      state: failed(
        "follow the pull request",
        "JigsError",
        "branch acme/abc-1 no longer exists on origin",
        "restore the branch or start another run",
      ),
      expected: "needs-human",
    },
  ],
});
