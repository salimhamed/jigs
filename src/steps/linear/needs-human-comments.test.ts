import { beforeEach, expect, test, vi } from "vitest";
import type { FactoryDefinition } from "../../workflow/factory.ts";
import type { Halt } from "../../workflow/linear/halt-for-human.ts";

const { createComment, findUserByEmail, getIssueParticipants, listCommentsSince, runOperator } =
  vi.hoisted(() => ({
    runOperator: vi.fn(async (): Promise<string | undefined> => undefined),
    findUserByEmail: vi.fn(
      async (_email: string): Promise<{ id: string; name: string } | null> => null,
    ),
    createComment: vi.fn(async (_issueId: string, _body: string) => ({
      id: "comment-1",
      createdAt: "2026-08-31T12:00:00.000Z",
    })),
    listCommentsSince: vi.fn(
      async (_issueId: string, _sinceIso: string) =>
        [] as Array<{
          id: string;
          body: string;
          createdAt: string;
          user: { id: string; name: string } | null;
        }>,
    ),
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
  findUserByEmail,
  getIssueParticipants,
  listCommentsSince,
}));

vi.mock("./mentions.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mentions.ts")>()),
  runOperator,
}));

const { checkForTicketHumanReply, postTicketHumanInputRequest, postTicketNote } = await import(
  "./needs-human-comments.ts"
);

const context = {
  workflowRunId: "wrun_01M26",
  workflowName: "ship",
};

// The step reads the operator through runOperator, which is mocked here.
const definition = { workflows: {} } as unknown as FactoryDefinition;

const body = (): string => createComment.mock.calls[0]?.[1] ?? "";

beforeEach(() => {
  vi.stubEnv("JIGS_DASHBOARD_PORT", "9040");
  createComment.mockClear();
  getIssueParticipants.mockClear();
  runOperator.mockReset();
  runOperator.mockResolvedValue(undefined);
  findUserByEmail.mockReset();
  findUserByEmail.mockResolvedValue(null);
  getIssueParticipants.mockResolvedValue({
    creator: { id: "user-1", name: "Salim" },
    assignee: { id: "user-2", name: "Dana" },
  });
});

const questions: Halt = {
  headline: "jigs paused work on **AI-659** and needs your answers before it writes any code.",
  where: "ticket review",
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
// the run and the work it paused — the four things the rendering this replaced
// got wrong.
test("a two-question halt renders as numbered questions with lettered options", async () => {
  await postTicketHumanInputRequest("issue-1", questions, context, definition);

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

<sub>Run wrun_01M26 · workflow \`ship\` · paused at ticket review · [dashboard](http://localhost:9040/run/wrun_01M26)</sub>
`,
  );
  expect(createComment).toHaveBeenCalledWith("issue-1", body());
});

test("a retry halt renders its notes and asks for any reply at all", async () => {
  await postTicketHumanInputRequest(
    "issue-1",
    {
      headline: "jigs could not start a step on **AI-659** because a check failed.",
      where: "starting a step",
      notes: [
        "MCP server 'linear': did not start — fix the 'linear' server",
        "AWS credentials: the session expired — run: aws sso login --profile prod",
      ],
      onReply: "retry",
    },
    { workflowRunId: "wrun_2", workflowName: "ship" },
    definition,
  );

  expect(body()).toBe(
    `@[Salim](user-1) @[Dana](user-2) — jigs could not start a step on **AI-659** because a check failed.

Once this is fixed, reply with anything and jigs will try the step again.

---

- MCP server 'linear': did not start — fix the 'linear' server
- AWS credentials: the session expired — run: aws sso login --profile prod

---

<sub>Run wrun_2 · workflow \`ship\` · paused at starting a step · [dashboard](http://localhost:9040/run/wrun_2)</sub>
`,
  );
});

test("the creator and the assignee are one mention when they are one person", async () => {
  getIssueParticipants.mockResolvedValue({
    creator: { id: "user-1", name: "Salim" },
    assignee: { id: "user-1", name: "Salim" },
  });
  await postTicketHumanInputRequest("issue-1", questions, context, definition);
  expect(body().split("\n")[0]).toBe(
    "@[Salim](user-1) — jigs paused work on **AI-659** and needs your answers before it writes any code.",
  );
});

test("an unassigned ticket greets its creator alone", async () => {
  getIssueParticipants.mockResolvedValue({
    creator: { id: "user-1", name: "Salim" },
    assignee: null,
  });
  await postTicketHumanInputRequest("issue-1", questions, context, definition);
  expect(body().split("\n")[0]).toBe(
    "@[Salim](user-1) — jigs paused work on **AI-659** and needs your answers before it writes any code.",
  );
});

test("a ticket with nobody on it gets the headline without a dangling dash", async () => {
  getIssueParticipants.mockResolvedValue({ creator: null, assignee: null });
  await postTicketHumanInputRequest("issue-1", questions, context, definition);
  expect(body().split("\n")[0]).toBe(
    "jigs paused work on **AI-659** and needs your answers before it writes any code.",
  );
});

test("a note greets the participants, bullets its lines, and closes with what to do", async () => {
  await postTicketNote(
    "issue-1",
    {
      headline:
        "jigs is starting work on AI-659. Before writing code, the reviewer read the ticket and made these assumptions:",
      notes: [
        "Only the validate script changes.",
        "The build folder is created before Docker starts.",
      ],
      closing:
        "jigs is going ahead with these assumptions. To change one, comment on the pull request once it opens.",
    },
    context,
    definition,
  );

  expect(body()).toBe(
    `@[Salim](user-1) @[Dana](user-2) — jigs is starting work on AI-659. Before writing code, the reviewer read the ticket and made these assumptions:

- Only the validate script changes.
- The build folder is created before Docker starts.

jigs is going ahead with these assumptions. To change one, comment on the pull request once it opens.
`,
  );
});

test("a factory's own renderer replaces the comment without replacing the step", async () => {
  await postTicketHumanInputRequest(
    "issue-1",
    questions,
    context,
    definition,
    (halt) => `just: ${halt.headline}`,
  );
  expect(body()).toBe(
    "just: jigs paused work on **AI-659** and needs your answers before it writes any code.",
  );
});

test("a note returns the id of the comment it posted", async () => {
  expect(
    await postTicketNote(
      "issue-1",
      { headline: "Done.", notes: [], closing: "" },
      context,
      definition,
    ),
  ).toEqual({ commentId: "comment-1" });
});

const users: Record<string, { id: string; name: string }> = {
  "op@example.com": { id: "user-9", name: "Olu" },
  "dana@example.com": { id: "user-2", name: "Dana" },
  "kim@example.com": { id: "user-5", name: "Kim" },
};
const byEmail = async (email: string) => users[email] ?? null;
const greeting = (): string => body().split(" — ")[0] ?? "";

test("with an operator, a comment mentions the operator and the assignee, not the creator", async () => {
  runOperator.mockResolvedValue("op@example.com");
  findUserByEmail.mockImplementation(byEmail);
  await postTicketHumanInputRequest("issue-1", questions, context, definition);
  expect(runOperator).toHaveBeenCalledWith(context, definition);
  expect(greeting()).toBe("@[Olu](user-9) @[Dana](user-2)");
});

test("an operator who is also the assignee is mentioned once", async () => {
  runOperator.mockResolvedValue("dana@example.com");
  findUserByEmail.mockImplementation(byEmail);
  await postTicketHumanInputRequest("issue-1", questions, context, definition);
  expect(greeting()).toBe("@[Dana](user-2)");
});

test("an operator Linear cannot find leaves the assignee alone, with a warning", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  runOperator.mockResolvedValue("gone@example.com");
  findUserByEmail.mockImplementation(byEmail);
  await postTicketHumanInputRequest("issue-1", questions, context, definition);
  expect(greeting()).toBe("@[Dana](user-2)");
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("gone@example.com"));
  warn.mockRestore();
});

test("a failed operator lookup still posts, mentioning the assignee", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  runOperator.mockResolvedValue("op@example.com");
  findUserByEmail.mockRejectedValue(new Error("Linear API 500"));
  const posted = await postTicketNote(
    "issue-1",
    { headline: "Done.", notes: [], closing: "" },
    context,
    definition,
  );
  expect(posted).toEqual({ commentId: "comment-1" });
  expect(greeting()).toBe("@[Dana](user-2)");
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("Linear API 500"));
  warn.mockRestore();
});

test("extra mentions follow the operator and assignee, once each, skipping unknown emails", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  runOperator.mockResolvedValue("op@example.com");
  findUserByEmail.mockImplementation(byEmail);
  await postTicketNote(
    "issue-1",
    {
      headline: "Done.",
      notes: [],
      closing: "",
      mention: ["kim@example.com", "dana@example.com", "nobody@example.com", "kim@example.com"],
    },
    context,
    definition,
  );
  expect(greeting()).toBe("@[Olu](user-9) @[Dana](user-2) @[Kim](user-5)");
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("nobody@example.com"));
  warn.mockRestore();
});

test("without an operator, extra mentions join the creator and assignee", async () => {
  findUserByEmail.mockImplementation(byEmail);
  await postTicketHumanInputRequest(
    "issue-1",
    { ...questions, mention: ["kim@example.com"] },
    context,
    definition,
  );
  expect(findUserByEmail).toHaveBeenCalledTimes(1);
  expect(greeting()).toBe("@[Salim](user-1) @[Dana](user-2) @[Kim](user-5)");
});

test("a custom renderer receives the resolved mentions", async () => {
  runOperator.mockResolvedValue("op@example.com");
  findUserByEmail.mockImplementation(byEmail);
  const render = vi.fn(() => "custom");
  await postTicketNote(
    "issue-1",
    { headline: "Done.", notes: [], closing: "", mention: ["kim@example.com"] },
    context,
    definition,
    render,
  );
  expect(render).toHaveBeenCalledWith(expect.anything(), {
    creator: { id: "user-1", name: "Salim" },
    assignee: { id: "user-2", name: "Dana" },
    operator: { id: "user-9", name: "Olu" },
    mentions: [
      { id: "user-9", name: "Olu" },
      { id: "user-2", name: "Dana" },
      { id: "user-5", name: "Kim" },
    ],
  });
});

test("a reply check skips every comment the run posted and moves the cursor past them", async () => {
  const salim = { id: "user-1", name: "Salim" };
  listCommentsSince.mockResolvedValueOnce([
    { id: "note", body: "jigs note", createdAt: "2026-08-31T12:01:00.000Z", user: salim },
    { id: "question", body: "jigs halt", createdAt: "2026-08-31T12:02:00.000Z", user: salim },
    { id: "answer", body: "left", createdAt: "2026-08-31T12:03:00.000Z", user: salim },
  ]);
  expect(
    await checkForTicketHumanReply("issue-1", "2026-08-31T12:00:00.000Z", ["note", "question"]),
  ).toEqual({
    reply: {
      commentId: "answer",
      body: "left",
      author: salim,
      createdAt: "2026-08-31T12:03:00.000Z",
    },
    cursor: "2026-08-31T12:03:00.000Z",
  });

  listCommentsSince.mockResolvedValueOnce([
    { id: "note", body: "jigs note", createdAt: "2026-08-31T12:04:00.000Z", user: salim },
  ]);
  expect(await checkForTicketHumanReply("issue-1", "2026-08-31T12:03:00.000Z", ["note"])).toEqual({
    reply: null,
    cursor: "2026-08-31T12:04:00.000Z",
  });
});
