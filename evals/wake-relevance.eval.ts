import {
  WAKE_RELEVANCE_CUTOFF,
  wakeEvidence,
  wakeRelevance,
} from "../src/service/wake-relevance.ts";
import type { JevState } from "../src/workflow/agents/jev.ts";
import { evalSite } from "./harness.ts";

const github = (event: string, payload: Record<string, unknown>): JevState => {
  const state = wakeEvidence("github", event, payload);
  if (state === null) throw new Error(`${event} always wakes; it is not a relevance case`);
  return state;
};
const linear = (event: string, payload: Record<string, unknown>): JevState => {
  const state = wakeEvidence("linear", event, payload);
  if (state === null) throw new Error(`${event} always wakes; it is not a relevance case`);
  return state;
};

evalSite("wake-relevance", {
  question: wakeRelevance,
  cutoff: WAKE_RELEVANCE_CUTOFF,
  cases: [
    {
      name: "reviewer requests changes",
      state: github("pull_request_review", {
        action: "submitted",
        review: { state: "changes_requested", body: "The retry loop never stops on 4xx." },
        sender: { login: "dana", type: "User" },
      }),
      expected: true,
    },
    {
      name: "human asks a question in the conversation",
      state: github("issue_comment", {
        action: "created",
        comment: { body: "Why did you drop the cache here?" },
        sender: { login: "dana", type: "User" },
      }),
      expected: true,
    },
    {
      name: "label added",
      state: github("pull_request", {
        action: "labeled",
        label: { name: "size/M" },
        sender: { login: "labeler[bot]", type: "Bot" },
      }),
      expected: false,
    },
    {
      name: "coverage bot comment",
      state: github("issue_comment", {
        action: "created",
        comment: { body: "Coverage: 91.2% (+0.1%). No files changed coverage." },
        sender: { login: "codecov[bot]", type: "Bot" },
      }),
      expected: false,
    },
    {
      name: "assignee changed",
      state: github("pull_request", {
        action: "assigned",
        sender: { login: "dana", type: "User" },
      }),
      expected: false,
    },
    {
      name: "inline review comment",
      state: github("pull_request_review_comment", {
        action: "created",
        comment: { body: "This should use the shared client.", path: "src/api.ts" },
        sender: { login: "dana", type: "User" },
      }),
      expected: true,
    },
    {
      name: "Linear comment answering the agent",
      state: linear("Comment", {
        action: "create",
        data: { body: "Use exponential backoff, max 5 tries." },
      }),
      expected: true,
    },
    {
      name: "Linear priority shuffle",
      state: linear("Issue", {
        action: "update",
        data: { title: "Webhook retries", priority: 2 },
        updatedFrom: { priority: 3 },
      }),
      expected: false,
    },
  ],
});
