import { beforeEach, expect, test, vi } from "vitest";
import { githubGet, githubRequest } from "./github-api.ts";
import { getBranchProtection, putBranchProtection } from "./github-branch-protection.ts";

vi.mock("./github-api.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./github-api.ts")>();
  return { ...original, githubGet: vi.fn(), githubRequest: vi.fn() };
});

const getMock = vi.mocked(githubGet);
const requestMock = vi.mocked(githubRequest);
const repo = { owner: "salim", repo: "jigs" };

beforeEach(() => vi.clearAllMocks());

test("the protection payload preserves check App identity and review bypass allowances", async () => {
  getMock.mockResolvedValueOnce({
    required_status_checks: {
      strict: true,
      contexts: ["legacy/status"],
      checks: [{ context: "build", app_id: 15368 }],
    },
    required_pull_request_reviews: {
      required_approving_review_count: 1,
      dismiss_stale_reviews: true,
      require_code_owner_reviews: true,
      require_last_push_approval: true,
      bypass_pull_request_allowances: {
        users: [{ login: "release-manager" }],
        teams: [{ slug: "release" }],
        apps: [{ slug: "mergify" }],
      },
    },
    enforce_admins: { enabled: true },
  });
  const current = await getBranchProtection(repo, "main");

  await putBranchProtection(repo, "main", current, current);

  expect(requestMock).toHaveBeenCalledWith(
    "PUT",
    "/repos/salim/jigs/branches/main/protection",
    expect.objectContaining({
      required_status_checks: {
        strict: true,
        contexts: ["legacy/status"],
        checks: [{ context: "build", app_id: 15368 }],
      },
      required_pull_request_reviews: expect.objectContaining({
        bypass_pull_request_allowances: {
          users: ["release-manager"],
          teams: ["release"],
          apps: ["mergify"],
        },
      }),
    }),
  );
});

test("personal-repository payloads omit absent organization-only review restrictions", async () => {
  getMock.mockResolvedValueOnce({
    required_status_checks: { strict: false, contexts: ["test"], checks: [] },
    required_pull_request_reviews: { required_approving_review_count: 1 },
  });
  const current = await getBranchProtection(repo, "main");

  await putBranchProtection(repo, "main", current, current);

  const body = requestMock.mock.calls[0]?.[2] as {
    required_pull_request_reviews: Record<string, unknown>;
  };
  expect(body.required_pull_request_reviews).not.toHaveProperty("dismissal_restrictions");
  expect(body.required_pull_request_reviews).not.toHaveProperty("bypass_pull_request_allowances");
});
