import { LINEAR_DECISION_CUTOFF, ticketReadiness } from "../src/workflow/linear/decisions.ts";
import { evalSite } from "./harness.ts";

const ticket = (title: string, description: string) => `# ${title}\n\n${description}`;

evalSite("ticket-readiness", {
  question: ticketReadiness,
  cutoff: LINEAR_DECISION_CUTOFF,
  cases: [
    {
      name: "clear small change",
      state: ticket(
        "Rename the `--json` flag to `--format json`",
        "`jigs status --json` should become `jigs status --format json`. Keep output identical. Done when the old flag errors with a hint pointing at the new one.",
      ),
      expected: "ready",
    },
    {
      name: "vague improvement",
      state: ticket("Make the dashboard better", "It feels slow and clunky."),
      expected: "no-acceptance-criteria",
    },
    {
      name: "bug without reproduction",
      state: ticket("Worktrees broken", "Sometimes worktrees don't work."),
      expected: "missing-reproduction",
    },
    {
      name: "bug with reproduction",
      state: ticket(
        "`jigs prune` deletes a live run's worktree",
        "Steps: start a run, pause it on a halt, run `jigs prune`. Expected: the paused run's worktree stays. Actual: it is deleted and the run fails on resume with ENOENT.",
      ),
      expected: "ready",
    },
    {
      name: "contradiction",
      state: ticket(
        "Retry policy for webhooks",
        "Never retry failed webhook deliveries; they must be delivered at most once. Also, retry each failed delivery three times so none are lost.",
      ),
      expected: "conflicting-requirements",
    },
    {
      name: "project-sized",
      state: ticket(
        "Slack integration",
        "Add Slack: post run status to channels, let people approve halts from Slack, add slash commands to start runs, sync Slack threads with Linear comments, and build an admin page for workspace settings.",
      ),
      expected: "too-large",
    },
    {
      name: "short but clear",
      state: ticket(
        "Fix typo in README",
        '"recieve" should be "receive" in the Quick start section.',
      ),
      expected: "ready",
    },
  ],
});
