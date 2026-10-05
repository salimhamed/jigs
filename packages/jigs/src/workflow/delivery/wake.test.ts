import { describe, expect, test } from "vitest";
import type { PullRequestSnapshot } from "../pull-requests/snapshot.ts";
import { builderWakeFacts } from "./wake.ts";

const opened: PullRequestSnapshot = {
  appBot: "jigs[bot]",
  state: "open",
  merged: false,
  draft: false,
  headSha: "h1",
  mergeState: "unknown",
  labels: [],
  mergeCommitSha: null,
  ci: "none",
  failingChecks: [],
  reviews: [],
  reviewThreads: [],
  conversationComments: [],
  approval: { signal: "review", state: "none" },
};
const SCOPE = "linearTicketToPr/ABC-1";
const marked = (marker: object) => ({
  ...comment,
  id: 4,
  userType: "Bot",
  body: `A note.\n\n<!-- jigs:v1 ${JSON.stringify({ run: "r", source: "h1", ...marker })} -->`,
});
const check = (name: string) => ({ name, conclusion: "failure", url: `https://ci/${name}` });
const comment = {
  id: 3,
  body: "Typo",
  user: "will",
  userType: "User",
  createdAt: "t1",
  updatedAt: "t1",
};
const review = (state: string, body: string) => ({
  id: 9,
  state,
  body,
  user: "will",
  submittedAt: "t1",
  commitSha: "h1",
});
const wakes = (from: PullRequestSnapshot, to: PullRequestSnapshot) => {
  const seen = new Set(builderWakeFacts(from, SCOPE));
  return builderWakeFacts(to, SCOPE).some((fact) => !seen.has(fact));
};

test("a freshly opened pull request with nothing to act on has nothing to wake the builder for", () => {
  expect(builderWakeFacts(opened, SCOPE)).toEqual([]);
});

test("checks queuing, running, passing and clearing never wake the builder", () => {
  const states = [
    opened,
    { ...opened, ci: "pending" as const, mergeState: "blocked" },
    { ...opened, ci: "green" as const, mergeState: "clean" },
    { ...opened, ci: "green" as const, mergeState: "clean", labels: ["jigs:approved"] },
  ];
  for (const state of states) expect(builderWakeFacts(state, SCOPE)).toEqual([]);
  const failed = { ...opened, ci: "red" as const, failingChecks: [check("build")] };
  expect(wakes(failed, { ...opened, ci: "pending" })).toBe(false);
});

const failed = { ...opened, ci: "red" as const, failingChecks: [check("build")] };

test("a newly failed check wakes the builder; the same failure on the same head does not", () => {
  const failed = { ...opened, ci: "red" as const, failingChecks: [check("build")] };
  expect(wakes(opened, failed)).toBe(true);
  expect(
    wakes(failed, { ...failed, failingChecks: [{ ...check("build"), url: "https://ci/rerun" }] }),
  ).toBe(false);
  expect(wakes(failed, { ...failed, headSha: "h2" })).toBe(true);
  expect(wakes(failed, { ...failed, failingChecks: [check("build"), check("lint")] })).toBe(true);
});

test("new or edited discussion wakes the builder", () => {
  const commented = { ...opened, conversationComments: [comment] };
  expect(wakes(opened, commented)).toBe(true);
  expect(wakes(commented, commented)).toBe(false);
  expect(
    wakes(commented, { ...opened, conversationComments: [{ ...comment, updatedAt: "t2" }] }),
  ).toBe(true);
  const thread = {
    rootId: 5,
    path: "a.ts",
    line: 1,
    comments: [
      {
        id: 5,
        rootId: 5,
        body: "Why?",
        user: "will",
        path: "a.ts",
        line: 1,
        createdAt: "t1",
        updatedAt: "t1",
      },
    ],
  };
  expect(wakes(opened, { ...opened, reviewThreads: [thread] })).toBe(true);
  expect(wakes(opened, { ...opened, reviews: [review("CHANGES_REQUESTED", "")] })).toBe(true);
  expect(wakes(opened, { ...opened, reviews: [review("COMMENTED", "One question")] })).toBe(true);
});

test("a bare approval is consent to merge, not discussion for the builder", () => {
  expect(builderWakeFacts({ ...opened, reviews: [review("APPROVED", "")] }, SCOPE)).toEqual([]);
  expect(
    builderWakeFacts({ ...opened, reviews: [review("APPROVED", "LGTM, one nit")] }, SCOPE),
  ).not.toEqual([]);
});

test("a conflict with the base wakes the builder once per head", () => {
  const dirty = { ...opened, mergeState: "dirty" };
  expect(wakes(opened, dirty)).toBe(true);
  expect(wakes(dirty, dirty)).toBe(false);
  expect(wakes(dirty, { ...dirty, headSha: "h2" })).toBe(true);
});

test("edits of a bot's sticky comment do not wake the builder; its new comments and human edits do", () => {
  const bot = { ...comment, user: "codecov[bot]", userType: "Bot" };
  const botted = { ...opened, conversationComments: [bot] };
  expect(wakes(opened, botted)).toBe(true);
  expect(
    wakes(botted, { ...opened, conversationComments: [{ ...bot, updatedAt: "t2", body: "92%" }] }),
  ).toBe(false);
  const botComment = {
    id: 6,
    rootId: 6,
    body: "Lint",
    user: "linter[bot]",
    path: "a.ts",
    line: 1,
    createdAt: "t1",
    updatedAt: "t1",
  };
  const botThread = {
    rootId: 6,
    path: "a.ts",
    line: 1,
    comments: [botComment],
  };
  const threaded = { ...opened, reviewThreads: [botThread] };
  const edited = { ...botThread, comments: [{ ...botComment, updatedAt: "t2" }] };
  expect(wakes(threaded, { ...opened, reviewThreads: [edited] })).toBe(false);
});

test("a review, a comment, a failure and a conflict are one fact each", () => {
  const busy = {
    ...failed,
    mergeState: "dirty",
    conversationComments: [comment],
    reviews: [review("CHANGES_REQUESTED", "")],
  };
  expect(builderWakeFacts(busy, SCOPE)).toHaveLength(4);
});

test("only this scope's own status notes are kept from the builder", () => {
  const status = { kind: "status", reason: "merge-retry" };
  const facts = (marker: object) =>
    builderWakeFacts({ ...opened, conversationComments: [marked(marker)] }, SCOPE);
  expect(facts({ scope: SCOPE, ...status })).toEqual([]);
  // Another jigs workflow's note, or anything but a status note, is still news.
  expect(facts({ scope: "otherWorkflow/ABC-1", ...status })).toHaveLength(1);
  expect(facts({ scope: SCOPE, kind: "reply" })).toHaveLength(1);
});

describe("the builder's own replies, posted as the App's bot", () => {
  const APP_BOT = "jigs-dev[bot]";
  const asBot = { ...opened, appBot: APP_BOT };
  const reply = { ...comment, id: 7, user: APP_BOT, userType: "Bot", body: "Renamed x." };
  const threadOf = (user: string, body: string) => ({
    rootId: 8,
    path: "a.ts",
    line: 1,
    comments: [
      { id: 8, rootId: 8, body, user, path: "a.ts", line: 1, createdAt: "t1", updatedAt: "t1" },
    ],
  });

  test("an unmarked comment by the bot wakes nothing", () => {
    expect(builderWakeFacts({ ...asBot, conversationComments: [reply] }, SCOPE)).toEqual([]);
    expect(
      builderWakeFacts(
        { ...asBot, conversationComments: [{ ...reply, user: "Jigs-Dev[bot]" }] },
        SCOPE,
      ),
    ).toEqual([]);
    expect(
      builderWakeFacts({ ...asBot, reviewThreads: [threadOf(APP_BOT, "Fixed.")] }, SCOPE),
    ).toEqual([]);
  });

  test("a person's comment, another bot's and a marked note from another scope still wake", () => {
    expect(wakes(asBot, { ...asBot, conversationComments: [reply, comment] })).toBe(true);
    expect(wakes(asBot, { ...asBot, reviewThreads: [threadOf("will", "Why?")] })).toBe(true);
    const other = { ...reply, user: "codecov[bot]" };
    expect(wakes(asBot, { ...asBot, conversationComments: [other] })).toBe(true);
    const note = {
      ...marked({ scope: "otherWorkflow/ABC-1", kind: "status", reason: "merge-retry" }),
      user: APP_BOT,
    };
    expect(wakes(asBot, { ...asBot, conversationComments: [note] })).toBe(true);
  });

  test("a review by the bot still wakes", () => {
    const own = { ...review("COMMENTED", "Done"), user: APP_BOT };
    expect(wakes(asBot, { ...asBot, reviews: [own] })).toBe(true);
  });

  test("with a personal token there is no bot to recognize", () => {
    expect(wakes(opened, { ...opened, conversationComments: [reply] })).toBe(true);
  });
});
