import { beforeEach, expect, test, vi } from "vitest";
import type { Halt } from "../../blocks/ticket/halt-for-human.ts";

const { createComment, getIssueParticipants } = vi.hoisted(() => ({
  createComment: vi.fn(async (_issueId: string, _body: string) => ({
    id: "comment-1",
    createdAt: "2026-08-31T12:00:00.000Z",
  })),
  getIssueParticipants: vi.fn(async () => ({
    creator: { id: "user-1", name: "Salim" } as {
      id: string;
      name: string;
    } | null,
    assignee: { id: "user-2", name: "Dana" } as {
      id: string;
      name: string;
    } | null,
  })),
}));

vi.mock("../../providers/linear.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../providers/linear.ts")>()),
  createComment,
  getIssueParticipants,
}));

const { postNeedsHumanComment, postTicketNote } = await import(
  "./needs-human-comments.ts"
);

const context = {
  runId: "wrun_01M26",
  pipeline: "ship",
  pausedAt: "2026-09-11T12:00:00.000Z",
  dashboardUrl: "http://localhost:9040/run/wrun_01M26",
};

const body = (): string => createComment.mock.calls[0]?.[1] ?? "";

beforeEach(() => {
  createComment.mockClear();
  getIssueParticipants.mockClear();
  getIssueParticipants.mockResolvedValue({
    creator: { id: "user-1", name: "Salim" },
    assignee: { id: "user-2", name: "Dana" },
  });
});

const questions: Halt = {
  headline:
    "jigs paused work on **AI-659** and needs your answers before it writes any code.",
  about:
    "When the tests run inside Docker, the files they leave behind are owned by the wrong user. Nobody can delete them afterwards without special permissions.",
  questions: [
    {
      question: "Which of the two fixes should we use?",
      context: "The ticket offers two, but they behave differently.",
      options: [
        { label: "Run as whoever launched the tests.", recommended: true },
        { label: "Build one fixed user into the image." },
      ],
    },
    {
      question: "Should the fix cover the shortcut commands too?",
      options: [
        {
          label: "Yes, cover every way the container starts.",
          recommended: true,
        },
        { label: "No, only the validate script." },
        { label: "Something else." },
      ],
    },
  ],
  onReply: "continue",
};

// The whole comment, byte for byte. Question numbers increment, option letters
// increment, every question is fenced off by a divider, and the footer names
// the run — the four things the rendering this replaced got wrong.
test("a two-question halt renders as numbered questions with lettered options", async () => {
  await postNeedsHumanComment("issue-1", questions, context);

  expect(body()).toBe(
    `@[Salim](user-1) @[Dana](user-2) — jigs paused work on **AI-659** and needs your answers before it writes any code.

**What this ticket is about.** When the tests run inside Docker, the files they leave behind are owned by the wrong user. Nobody can delete them afterwards without special permissions.

Reply to this comment with your choices, for example \`1a, 2b\`. Plain words or a question are fine too. Any reply wakes the run.

---

### 1. Which of the two fixes should we use?

The ticket offers two, but they behave differently.

- **a)** Run as whoever launched the tests. *(recommended)*
- **b)** Build one fixed user into the image.

---

### 2. Should the fix cover the shortcut commands too?

- **a)** Yes, cover every way the container starts. *(recommended)*
- **b)** No, only the validate script.
- **c)** Something else.

---

<sub>Run wrun_01M26 · pipeline \`ship\` · paused at 2026-09-11T12:00:00.000Z · [dashboard](http://localhost:9040/run/wrun_01M26)</sub>
`,
  );
  expect(createComment).toHaveBeenCalledWith("issue-1", body());
});

test("a retry halt renders its notes and asks for any reply at all", async () => {
  await postNeedsHumanComment(
    "issue-1",
    {
      headline:
        "jigs could not start a step on **AI-659** because a check failed.",
      notes: [
        "MCP server 'linear': did not start — fix the 'linear' server",
        "AWS credentials: the session expired — run: aws sso login --profile prod",
      ],
      onReply: "retry",
    },
    { runId: "wrun_2", pausedAt: "2026-09-11T12:00:00.000Z" },
  );

  expect(body()).toBe(
    `@[Salim](user-1) @[Dana](user-2) — jigs could not start a step on **AI-659** because a check failed.

Once this is fixed, reply with anything and jigs will try the step again.

---

- MCP server 'linear': did not start — fix the 'linear' server
- AWS credentials: the session expired — run: aws sso login --profile prod

---

<sub>Run wrun_2 · paused at 2026-09-11T12:00:00.000Z</sub>
`,
  );
});

test("the creator and the assignee are one mention when they are one person", async () => {
  getIssueParticipants.mockResolvedValue({
    creator: { id: "user-1", name: "Salim" },
    assignee: { id: "user-1", name: "Salim" },
  });
  await postNeedsHumanComment("issue-1", questions, context);
  expect(body().split("\n")[0]).toBe(
    "@[Salim](user-1) — jigs paused work on **AI-659** and needs your answers before it writes any code.",
  );
});

test("an unassigned ticket greets its creator alone", async () => {
  getIssueParticipants.mockResolvedValue({
    creator: { id: "user-1", name: "Salim" },
    assignee: null,
  });
  await postNeedsHumanComment("issue-1", questions, context);
  expect(body().split("\n")[0]).toBe(
    "@[Salim](user-1) — jigs paused work on **AI-659** and needs your answers before it writes any code.",
  );
});

test("a ticket with nobody on it gets the headline without a dangling dash", async () => {
  getIssueParticipants.mockResolvedValue({ creator: null, assignee: null });
  await postNeedsHumanComment("issue-1", questions, context);
  expect(body().split("\n")[0]).toBe(
    "jigs paused work on **AI-659** and needs your answers before it writes any code.",
  );
});

test("the proceeding note lists the assumptions and says where a correction lands", async () => {
  await postTicketNote("issue-1", {
    identifier: "AI-659",
    assumptions: [
      "Only the validate script changes.",
      "The build folder is created before Docker starts.",
    ],
  });

  expect(body()).toBe(
    `@[Salim](user-1) @[Dana](user-2) — jigs is starting work on AI-659. Before writing code, the reviewer read the ticket and is going ahead on these assumptions:

- Only the validate script changes.
- The build folder is created before Docker starts.

If one of these is wrong, reply here now, or comment on the pull request when it opens. Once the builder starts, a reply on this ticket is not read again until the pull request's review threads.
`,
  );
});

test("a factory's own template replaces the comment without replacing the step", async () => {
  const { withPrompts } = await import("../prompts/jigs-prompts.ts");
  const prompts = withPrompts({
    "needs-human-comment": { template: "just: <%= it.HEADLINE %>" },
  });
  await postNeedsHumanComment("issue-1", questions, context, prompts);
  expect(body()).toBe(
    "just: jigs paused work on **AI-659** and needs your answers before it writes any code.",
  );
});
