import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { inTestFactory } from "../../test-fixtures.ts";
import type { FactoryDefinition } from "../../workflow/factory.ts";
import type { Halt } from "../../workflow/linear/halt-for-human.ts";

const { findUserByEmail, getIssueParticipants, postActivityOnce } = vi.hoisted(() => ({
  findUserByEmail: vi.fn(
    async (_email: string): Promise<{ id: string; name: string; url: string } | null> => null,
  ),
  getIssueParticipants: vi.fn(
    async (): Promise<{
      creator: { id: string; name: string; url: string } | null;
      assignee: { id: string; name: string; url: string } | null;
    }> => ({ creator: null, assignee: null }),
  ),
  postActivityOnce: vi.fn(
    async (_sessionId: string, _content: { type: string; body?: string }, _id: string) => ({
      id: "activity-1",
      createdAt: "2026-08-31T12:00:00.000Z",
    }),
  ),
}));

const linearFor = vi.hoisted(() => vi.fn());
vi.mock("../../providers/linear.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../providers/linear.ts")>()),
  linearFor,
}));
const linearAgentFor = vi.hoisted(() => vi.fn());
vi.mock("../../providers/linear-agent.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../providers/linear-agent.ts")>()),
  linearAgentFor,
}));

const { postTicketHumanInputRequest, postTicketNote } = await import("./ticket-session.ts");
const { stepPostingId } = await import("./agent-sessions.ts");

const context = {
  workflowRunId: "wrun_01M26",
  workflowName: "ship",
  stepId: "step_01",
};

const definition: FactoryDefinition = {
  hub: { url: "https://hub.example.test" },
  service: { dashboardPort: 9090 },
  workflows: {},
};
const operator = (email: string): FactoryDefinition => ({
  ...definition,
  linear: { operator: email },
});

const body = (): string => postActivityOnce.mock.calls[0]?.[1].body ?? "";

inTestFactory();

beforeEach(() => {
  linearFor.mockReturnValue({ findUserByEmail, getIssueParticipants });
  linearAgentFor.mockReturnValue({ postActivityOnce });
  postActivityOnce.mockClear();
  findUserByEmail.mockReset();
  findUserByEmail.mockResolvedValue(null);
  getIssueParticipants.mockReset();
  getIssueParticipants.mockResolvedValue({
    creator: { id: "user-1", name: "Salim", url: "https://linear.app/acme/profiles/salim" },
    assignee: { id: "user-2", name: "Dana", url: "https://linear.app/acme/profiles/dana" },
  });
});

const questions: Halt = {
  headline: "Work on **AI-659** is paused: your answers are needed before any code is written.",
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

// The whole question, byte for byte. Question numbers increment, option letters
// increment, every question is fenced off by a divider, and the footer names
// the run and the work it paused — the four things the rendering this replaced
// got wrong.
test("a two-question halt renders as numbered questions with lettered options", async () => {
  await postTicketHumanInputRequest(
    {
      installationName: "linear-acme",
      issueId: "issue-1",
      sessionId: "session-1",
      halt: questions,
    },
    context,
    definition,
  );

  expect(body()).toBe(
    `https://linear.app/acme/profiles/salim https://linear.app/acme/profiles/dana — Work on **AI-659** is paused: your answers are needed before any code is written.

**What this ticket is about.** When the tests run inside Docker, the files they leave behind are owned by the wrong user. Nobody can delete them afterwards without special permissions.

Reply here with your choices, for example \`1a, 2b\`. Plain words or a question are fine too. Any reply wakes the run.

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

<sub>Run wrun_01M26 · workflow \`ship\` · paused at ticket review</sub>
`,
  );
});

test("a retry halt renders its notes and asks for any reply at all", async () => {
  await postTicketHumanInputRequest(
    {
      installationName: "linear-acme",
      issueId: "issue-1",
      sessionId: "session-1",
      halt: {
        headline: "jigs could not start a step on **AI-659** because a check failed.",
        where: "starting a step",
        notes: [
          "MCP server 'linear': did not start — fix the 'linear' server",
          "AWS credentials: the session expired — run: aws sso login --profile prod",
        ],
        onReply: "retry",
      },
    },
    { workflowRunId: "wrun_2", workflowName: "ship", stepId: "step_01" },
    definition,
  );

  expect(body()).toBe(
    `https://linear.app/acme/profiles/salim https://linear.app/acme/profiles/dana — jigs could not start a step on **AI-659** because a check failed.

Once this is fixed, reply here with anything and the step will be tried again.

---

- MCP server 'linear': did not start — fix the 'linear' server
- AWS credentials: the session expired — run: aws sso login --profile prod

---

<sub>Run wrun_2 · workflow \`ship\` · paused at starting a step</sub>
`,
  );
});

test("the creator and the assignee are one mention when they are one person", async () => {
  getIssueParticipants.mockResolvedValue({
    creator: { id: "user-1", name: "Salim", url: "https://linear.app/acme/profiles/salim" },
    assignee: { id: "user-1", name: "Salim", url: "https://linear.app/acme/profiles/salim" },
  });
  await postTicketHumanInputRequest(
    {
      installationName: "linear-acme",
      issueId: "issue-1",
      sessionId: "session-1",
      halt: questions,
    },
    context,
    definition,
  );
  expect(body().split("\n")[0]).toBe(
    "https://linear.app/acme/profiles/salim — Work on **AI-659** is paused: your answers are needed before any code is written.",
  );
});

test("an unassigned ticket greets its creator alone", async () => {
  getIssueParticipants.mockResolvedValue({
    creator: { id: "user-1", name: "Salim", url: "https://linear.app/acme/profiles/salim" },
    assignee: null,
  });
  await postTicketHumanInputRequest(
    {
      installationName: "linear-acme",
      issueId: "issue-1",
      sessionId: "session-1",
      halt: questions,
    },
    context,
    definition,
  );
  expect(body().split("\n")[0]).toBe(
    "https://linear.app/acme/profiles/salim — Work on **AI-659** is paused: your answers are needed before any code is written.",
  );
});

test("a ticket with nobody on it gets the headline without a dangling dash", async () => {
  getIssueParticipants.mockResolvedValue({ creator: null, assignee: null });
  await postTicketHumanInputRequest(
    {
      installationName: "linear-acme",
      issueId: "issue-1",
      sessionId: "session-1",
      halt: questions,
    },
    context,
    definition,
  );
  expect(body().split("\n")[0]).toBe(
    "Work on **AI-659** is paused: your answers are needed before any code is written.",
  );
});

test("a note greets the participants, bullets its lines, and closes with what to do", async () => {
  await postTicketNote(
    {
      installationName: "linear-acme",
      issueId: "issue-1",
      sessionId: "session-1",
      note: {
        headline:
          "Starting work on AI-659. Before writing code, the reviewer read the ticket and made these assumptions:",
        notes: [
          "Only the validate script changes.",
          "The build folder is created before Docker starts.",
        ],
        closing:
          "Work is going ahead with these assumptions. To change one, comment on the pull request once it opens.",
      },
    },
    context,
    definition,
  );

  expect(body()).toBe(
    `https://linear.app/acme/profiles/salim https://linear.app/acme/profiles/dana — Starting work on AI-659. Before writing code, the reviewer read the ticket and made these assumptions:

- Only the validate script changes.
- The build folder is created before Docker starts.

Work is going ahead with these assumptions. To change one, comment on the pull request once it opens.
`,
  );
});

test("a factory's own renderer replaces the message without replacing the step", async () => {
  await postTicketHumanInputRequest(
    {
      installationName: "linear-acme",
      issueId: "issue-1",
      sessionId: "session-1",
      halt: questions,
    },
    context,
    definition,
    (halt) => `just: ${halt.headline}`,
  );
  expect(body()).toBe(
    "just: Work on **AI-659** is paused: your answers are needed before any code is written.",
  );
});

test("a question is an elicitation in the session, under an id derived from the run and step", async () => {
  await postTicketHumanInputRequest(
    {
      installationName: "linear-acme",
      issueId: "issue-1",
      sessionId: "session-1",
      halt: questions,
    },
    context,
    definition,
  );
  expect(linearAgentFor).toHaveBeenCalledWith("linear-acme");
  expect(postActivityOnce).toHaveBeenCalledExactlyOnceWith(
    "session-1",
    { type: "elicitation", body: body() },
    stepPostingId(context, "session-1"),
  );
});

test.each([
  ["ended", "response"],
  ["waiting", "elicitation"],
] as const)(
  "a note after which the run is %s is a %s, with no thought after it",
  async (run, type) => {
    await postTicketNote(
      {
        installationName: "linear-acme",
        issueId: "issue-1",
        sessionId: "session-1",
        note: { headline: "Done.", notes: [], closing: "", run },
      },
      context,
      definition,
    );
    expect(postActivityOnce).toHaveBeenCalledExactlyOnceWith(
      "session-1",
      { type, body: body() },
      stepPostingId(context, "session-1"),
    );
  },
);

test("any other note is a response, so its mentions notify, then a thought keeps the session working", async () => {
  await postTicketNote(
    {
      installationName: "linear-acme",
      issueId: "issue-1",
      sessionId: "session-1",
      note: { headline: "Done.", notes: [], closing: "" },
    },
    context,
    definition,
  );
  expect(postActivityOnce.mock.calls).toEqual([
    ["session-1", { type: "response", body: body() }, stepPostingId(context, "session-1")],
    [
      "session-1",
      { type: "thought", body: "Still working." },
      stepPostingId(context, "session-1:working"),
    ],
  ]);
});

const users: Record<string, { id: string; name: string; url: string }> = {
  "op@example.com": { id: "user-9", name: "Olu", url: "https://linear.app/acme/profiles/olu" },
  "dana@example.com": { id: "user-2", name: "Dana", url: "https://linear.app/acme/profiles/dana" },
  "kim@example.com": { id: "user-5", name: "Kim", url: "https://linear.app/acme/profiles/kim" },
};
const byEmail = async (email: string) => users[email] ?? null;
const greeting = (): string => body().split(" — ")[0] ?? "";

test("with an operator, a question mentions the operator and the assignee, not the creator", async () => {
  const definition = operator("op@example.com");
  findUserByEmail.mockImplementation(byEmail);
  await postTicketHumanInputRequest(
    {
      installationName: "linear-acme",
      issueId: "issue-1",
      sessionId: "session-1",
      halt: questions,
    },
    context,
    definition,
  );
  expect(greeting()).toBe(
    "https://linear.app/acme/profiles/olu https://linear.app/acme/profiles/dana",
  );
});

test("the operator comes from the passed definition, never from jigs.config.ts on disk", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "jigs-operator-"));
  vi.stubEnv("JIGS_FACTORY_ROOT", root);
  findUserByEmail.mockImplementation(byEmail);
  try {
    await postTicketNote(
      {
        installationName: "linear-acme",
        issueId: "issue-1",
        sessionId: "session-1",
        note: { headline: "Done.", notes: [], closing: "" },
      },
      context,
      definition,
    );
    expect(greeting()).toBe(
      "https://linear.app/acme/profiles/salim https://linear.app/acme/profiles/dana",
    );

    writeFileSync(
      path.join(root, "jigs.config.ts"),
      'export default { hub: { url: "https://hub.example.test" }, service: { dashboardPort: 9000 }, linear: { operator: "kim@example.com" } };',
    );
    postActivityOnce.mockClear();
    await postTicketNote(
      {
        installationName: "linear-acme",
        issueId: "issue-1",
        sessionId: "session-1",
        note: { headline: "Done.", notes: [], closing: "" },
      },
      context,
      operator("op@example.com"),
    );
    expect(greeting()).toBe(
      "https://linear.app/acme/profiles/olu https://linear.app/acme/profiles/dana",
    );
    expect(findUserByEmail).not.toHaveBeenCalledWith("kim@example.com");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an operator who is also the assignee is mentioned once", async () => {
  const definition = operator("dana@example.com");
  findUserByEmail.mockImplementation(byEmail);
  await postTicketHumanInputRequest(
    {
      installationName: "linear-acme",
      issueId: "issue-1",
      sessionId: "session-1",
      halt: questions,
    },
    context,
    definition,
  );
  expect(greeting()).toBe("https://linear.app/acme/profiles/dana");
});

test("an operator Linear cannot find leaves the assignee alone, with a warning", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const definition = operator("gone@example.com");
  findUserByEmail.mockImplementation(byEmail);
  await postTicketHumanInputRequest(
    {
      installationName: "linear-acme",
      issueId: "issue-1",
      sessionId: "session-1",
      halt: questions,
    },
    context,
    definition,
  );
  expect(greeting()).toBe("https://linear.app/acme/profiles/dana");
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("gone@example.com"));
  warn.mockRestore();
});

test("a failed operator lookup still posts, mentioning the assignee", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const definition = operator("op@example.com");
  findUserByEmail.mockRejectedValue(new Error("Linear API 500"));
  await postTicketNote(
    {
      installationName: "linear-acme",
      issueId: "issue-1",
      sessionId: "session-1",
      note: { headline: "Done.", notes: [], closing: "" },
    },
    context,
    definition,
  );
  expect(greeting()).toBe("https://linear.app/acme/profiles/dana");
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("Linear API 500"));
  warn.mockRestore();
});

test("extra mentions follow the operator and assignee, once each, skipping unknown emails", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const definition = operator("op@example.com");
  findUserByEmail.mockImplementation(byEmail);
  await postTicketNote(
    {
      installationName: "linear-acme",
      issueId: "issue-1",
      sessionId: "session-1",
      note: {
        headline: "Done.",
        notes: [],
        closing: "",
        mention: ["kim@example.com", "dana@example.com", "nobody@example.com", "kim@example.com"],
      },
    },
    context,
    definition,
  );
  expect(greeting()).toBe(
    "https://linear.app/acme/profiles/olu https://linear.app/acme/profiles/dana https://linear.app/acme/profiles/kim",
  );
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("nobody@example.com"));
  warn.mockRestore();
});

test("without an operator, extra mentions join the creator and assignee", async () => {
  findUserByEmail.mockImplementation(byEmail);
  await postTicketHumanInputRequest(
    {
      installationName: "linear-acme",
      issueId: "issue-1",
      sessionId: "session-1",
      halt: { ...questions, mention: ["kim@example.com"] },
    },
    context,
    definition,
  );
  expect(findUserByEmail).toHaveBeenCalledTimes(1);
  expect(greeting()).toBe(
    "https://linear.app/acme/profiles/salim https://linear.app/acme/profiles/dana https://linear.app/acme/profiles/kim",
  );
});

test("a ticket whose people cannot be read still posts, mentioning the operator and extras", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const definition = operator("op@example.com");
  findUserByEmail.mockImplementation(byEmail);
  getIssueParticipants.mockRejectedValueOnce(new Error("Linear API 502"));
  await postTicketHumanInputRequest(
    {
      installationName: "linear-acme",
      issueId: "issue-1",
      sessionId: "session-1",
      halt: { ...questions, mention: ["kim@example.com"] },
    },
    context,
    definition,
  );
  expect(postActivityOnce).toHaveBeenCalledTimes(1);
  expect(greeting()).toBe(
    "https://linear.app/acme/profiles/olu https://linear.app/acme/profiles/kim",
  );
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("Linear API 502"));
  warn.mockRestore();
});

test("a custom renderer receives the resolved mentions", async () => {
  const definition = operator("op@example.com");
  findUserByEmail.mockImplementation(byEmail);
  const render = vi.fn(() => "custom");
  await postTicketNote(
    {
      installationName: "linear-acme",
      issueId: "issue-1",
      sessionId: "session-1",
      note: { headline: "Done.", notes: [], closing: "", mention: ["kim@example.com"] },
    },
    context,
    definition,
    render,
  );
  expect(render).toHaveBeenCalledWith(expect.anything(), {
    creator: { id: "user-1", name: "Salim", url: "https://linear.app/acme/profiles/salim" },
    assignee: { id: "user-2", name: "Dana", url: "https://linear.app/acme/profiles/dana" },
    operator: { id: "user-9", name: "Olu", url: "https://linear.app/acme/profiles/olu" },
    mentions: [
      { id: "user-9", name: "Olu", url: "https://linear.app/acme/profiles/olu" },
      { id: "user-2", name: "Dana", url: "https://linear.app/acme/profiles/dana" },
      { id: "user-5", name: "Kim", url: "https://linear.app/acme/profiles/kim" },
    ],
  });
});
