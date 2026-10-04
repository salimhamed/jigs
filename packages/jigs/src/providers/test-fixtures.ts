// Route the process's GitHub or Slack calls to a client built on test fakes,
// restored by `vi.restoreAllMocks()`.

import { vi } from "vitest";
import { createGithubClient, type GithubClientDeps, githubClient } from "./github-http.ts";
import { createSlackClient, type SlackClientDeps, slackClient } from "./slack.ts";
import { type FetchCall, fakeFetch } from "./test-support.ts";

export function useGithubClient(deps: GithubClientDeps): void {
  const client = createGithubClient(deps);
  vi.spyOn(githubClient, "send").mockImplementation(client.send);
}

export function useSlackClient(deps: SlackClientDeps): void {
  const client = createSlackClient(deps);
  for (const key of Object.keys(client) as Array<keyof typeof client>) {
    vi.spyOn(slackClient, key).mockImplementation(client[key] as never);
  }
}

export interface FakeGithub {
  calls: FetchCall[];
  /** Queue the answer to the next unanswered call; an error is thrown as a network failure. */
  reply(res: Response | Error): FakeGithub;
}

/** Route this process's GitHub calls to a fake that answers each with the next queued reply. */
export function fakeGithub(deps: Pick<GithubClientDeps, "sleep"> = {}): FakeGithub {
  const replies: Array<Response | Error> = [];
  const { fetch, calls } = fakeFetch((call) => {
    const reply =
      replies.shift() ?? new Response(`no reply queued for ${call.url.pathname}`, { status: 599 });
    if (reply instanceof Error) throw reply;
    return reply;
  });
  useGithubClient({ ...deps, fetch });
  const github: FakeGithub = {
    calls,
    reply(res) {
      replies.push(res);
      return github;
    },
  };
  return github;
}
