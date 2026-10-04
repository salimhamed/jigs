// GitHub tests answer the client's calls in order through this, instead of
// stubbing the global fetch.

import { configureGithub, type GithubDeps } from "./github-http.ts";
import { type FetchCall, fakeFetch } from "./test-support.ts";

export interface FakeGithub {
  calls: FetchCall[];
  /** Queue the answer to the next unanswered call; an error is thrown as a network failure. */
  reply(res: Response | Error): FakeGithub;
}

/** Route this process's GitHub calls to a fake that answers each with the next queued reply. */
export function fakeGithub(deps: Pick<GithubDeps, "sleep"> = {}): FakeGithub {
  const replies: Array<Response | Error> = [];
  const { fetch, calls } = fakeFetch((call) => {
    const reply =
      replies.shift() ?? new Response(`no reply queued for ${call.url.pathname}`, { status: 599 });
    if (reply instanceof Error) throw reply;
    return reply;
  });
  configureGithub({ ...deps, fetch });
  const github: FakeGithub = {
    calls,
    reply(res) {
      replies.push(res);
      return github;
    },
  };
  return github;
}
