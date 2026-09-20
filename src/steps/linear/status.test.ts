import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../../providers/linear.ts", () => ({
  fetchIssueStates: vi.fn(),
  updateIssueState: vi.fn(),
}));

import { fetchIssueStates, updateIssueState } from "../../providers/linear.ts";
import { setTicketStatus } from "./status.ts";

const states = {
  state: { id: "todo", name: "Todo" },
  team: {
    name: "Development",
    states: {
      nodes: [
        { id: "todo", name: "Todo", type: "unstarted", position: 1 },
        { id: "review", name: "In Review", type: "started", position: 2 },
      ],
    },
  },
};

beforeEach(() => {
  vi.mocked(fetchIssueStates).mockReset();
  vi.mocked(updateIssueState).mockReset();
  vi.mocked(fetchIssueStates).mockResolvedValue(states);
  vi.mocked(updateIssueState).mockResolvedValue(undefined);
});

test("matches status names without regard to case and updates once", async () => {
  await expect(setTicketStatus("issue-1", "in review")).resolves.toEqual({
    from: "Todo",
    to: "In Review",
    changed: true,
  });
  expect(updateIssueState).toHaveBeenCalledTimes(1);
  expect(updateIssueState).toHaveBeenCalledWith("issue-1", "review");
});

test("does not write when the ticket already has the target state", async () => {
  await expect(setTicketStatus("issue-1", "todo")).resolves.toEqual({
    from: "Todo",
    to: "Todo",
    changed: false,
  });
  expect(updateIssueState).not.toHaveBeenCalled();
});

test("names the team and its available states when no name matches", async () => {
  await expect(setTicketStatus("issue-1", "Blocked")).rejects.toThrow(
    "Linear team Development has no state named Blocked. Available states: Todo, In Review.",
  );
  expect(updateIssueState).not.toHaveBeenCalled();
});
