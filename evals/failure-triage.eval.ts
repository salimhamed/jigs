import { failureTriage } from "../recipes/linear-ticket-to-pr/decisions.ts";
import { evalSite } from "./harness.ts";

const failed = (phase: string, name: string, message: string, hint: string | null = null) => ({
  phase,
  attempt: 1,
  name,
  message,
  hint,
});

evalSite("failure-triage", {
  question: failureTriage,
  cutoff: 0.9,
  cases: [
    {
      name: "GitHub 502",
      state: failed("publish", "Error", "GitHub API responded 502 Bad Gateway"),
      expected: "transient",
    },
    {
      name: "socket reset",
      state: failed("follow the pull request", "Error", "read ECONNRESET"),
      expected: "transient",
    },
    {
      name: "rate limited",
      state: failed(
        "implement and review",
        "Error",
        "429 Too Many Requests: rate limit exceeded, retry after 30s",
      ),
      expected: "transient",
    },
    {
      name: "token lacks permission",
      state: failed(
        "publish",
        "JigsError",
        "GitHub rejected the push: Resource not accessible by integration",
        "grant the GitHub App contents: write on this repository",
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
