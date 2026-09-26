import {
  WAKE_RELEVANCE_CUTOFF,
  type Waiting,
  wakeEvidence,
  wakeRelevance,
  wakeState,
} from "../src/service/wake-relevance.ts";
import type { JevState } from "../src/workflow/agents/jev.ts";
import { evalSite } from "./harness.ts";

const github = (event: string, payload: Record<string, unknown>, waiting: Waiting): JevState => {
  const evidence = wakeEvidence("github", event, payload);
  if (evidence === null) throw new Error(`${event} always wakes; it is not a relevance case`);
  return wakeState(evidence, waiting);
};
const linear = (event: string, payload: Record<string, unknown>, waiting: Waiting): JevState => {
  const evidence = wakeEvidence("linear", event, payload);
  if (evidence === null) throw new Error(`${event} always wakes; it is not a relevance case`);
  return wakeState(evidence, waiting);
};

// What the ingress reads for a run watching a pull request and for a run halted on a question.
const watching: Waiting = {
  for: "pull request activity",
  pullRequest: "acme/app#41",
  reactsTo:
    "CI results, reviews, review comments and conversation comments that ask for changes or answers, merges and closes",
  head: "3f9c2ab",
  draft: false,
};
const askedAboutRetries: Waiting = {
  for: "a human reply",
  question:
    "**jigs paused ENG-212 and needs a decision.** Should webhook retries use a fixed delay or exponential backoff, and how many tries before giving up?",
};
const working: Waiting = {
  for: "nothing on this ticket",
  note: "The run is working and has no question open on this ticket.",
};

evalSite("wake-relevance", {
  question: wakeRelevance,
  cutoff: WAKE_RELEVANCE_CUTOFF,
  cases: [
    {
      name: "reviewer requests changes",
      state: github(
        "pull_request_review",
        {
          action: "submitted",
          review: { state: "changes_requested", body: "The retry loop never stops on 4xx." },
          sender: { login: "dana", type: "User" },
        },
        watching,
      ),
      expected: true,
    },
    {
      name: "human asks a question in the conversation",
      state: github(
        "issue_comment",
        {
          action: "created",
          comment: { body: "Why did you drop the cache here?" },
          sender: { login: "dana", type: "User" },
        },
        watching,
      ),
      expected: true,
    },
    {
      name: "label added",
      state: github(
        "pull_request",
        {
          action: "labeled",
          label: { name: "size/M" },
          sender: { login: "labeler[bot]", type: "Bot" },
        },
        watching,
      ),
      expected: false,
    },
    {
      name: "coverage bot comment",
      state: github(
        "issue_comment",
        {
          action: "created",
          comment: { body: "Coverage: 91.2% (+0.1%). No files changed coverage." },
          sender: { login: "codecov[bot]", type: "Bot" },
        },
        watching,
      ),
      expected: false,
    },
    {
      name: "assignee changed",
      state: github(
        "pull_request",
        { action: "assigned", sender: { login: "dana", type: "User" } },
        watching,
      ),
      expected: false,
    },
    {
      name: "inline review comment",
      state: github(
        "pull_request_review_comment",
        {
          action: "created",
          comment: { body: "This should use the shared client.", path: "src/api.ts" },
          sender: { login: "dana", type: "User" },
        },
        watching,
      ),
      expected: true,
    },
    {
      name: "jigs' own status note on the pull request",
      state: github(
        "issue_comment",
        {
          action: "created",
          comment: {
            body: 'CI is green and the change is approved; waiting for a human to merge.\n\n<!-- jigs:v1 {"scope":"linear-ticket-to-pr:ENG-212","run":"wrun_01","kind":"status","reason":"merge"} -->',
          },
          sender: { login: "salim", type: "User" },
        },
        watching,
      ),
      expected: false,
    },
    {
      name: "Linear comment answering the agent",
      state: linear(
        "Comment",
        { action: "create", data: { body: "Use exponential backoff, max 5 tries." } },
        askedAboutRetries,
      ),
      expected: true,
    },
    {
      name: "Linear priority shuffle",
      state: linear(
        "Issue",
        {
          action: "update",
          data: { title: "Webhook retries", priority: 2 },
          updatedFrom: { priority: 3 },
        },
        askedAboutRetries,
      ),
      expected: false,
    },
    {
      name: "Linear comment while the run has no question open",
      state: linear(
        "Comment",
        { action: "create", data: { body: "FYI the staging deploy is at 3pm today." } },
        working,
      ),
      expected: false,
    },
  ],
});
