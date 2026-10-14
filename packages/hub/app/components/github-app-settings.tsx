import type { ReactNode } from "react";
import { card, table } from "./ui.ts";

const permissions: { name: string; access: string; why: ReactNode }[] = [
  { name: "Contents", access: "Read and write", why: "Clone, push and merge" },
  {
    name: "Pull requests",
    access: "Read and write",
    why: "Open, review, comment on and merge pull requests",
  },
  {
    name: "Issues",
    access: "Read and write",
    why: "Comment, add labels and assign, on issues and pull requests",
  },
  { name: "Checks", access: "Read-only", why: "Read CI results" },
  { name: "Commit statuses", access: "Read-only", why: "Read CI results that report statuses" },
  { name: "Metadata", access: "Read-only", why: "GitHub requires it" },
  {
    name: "Workflows",
    access: "Read and write",
    why: (
      <>
        Optional. Only if agents may change files in <code>.github/workflows</code>; GitHub refuses
        those pushes without it.
      </>
    ),
  },
];

const events: { name: string; why: string }[] = [
  { name: "Check suite", why: "Wakes runs waiting on CI" },
  { name: "Issue comment", why: "Wakes runs waiting on a pull request comment" },
  { name: "Issues", why: "Starts runs from issues" },
  { name: "Pull request", why: "Wakes runs waiting on a pull request, and starts runs" },
  { name: "Pull request review", why: "Wakes runs waiting on a review" },
  { name: "Pull request review comment", why: "Wakes runs waiting on a review comment" },
  { name: "Push", why: "Starts runs from pushes" },
  { name: "Release", why: "Starts runs from releases" },
  { name: "Status", why: "Wakes runs waiting on CI that reports statuses" },
];

/** The repository permissions a GitHub App for factories needs, one per row. */
export function GitHubPermissions() {
  return (
    <div className={`${card} overflow-x-auto`}>
      <table className={`${table} [&_td]:align-top`}>
        <thead>
          <tr>
            <th>Permission</th>
            <th>Access</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {permissions.map(({ name, access, why }) => (
            <tr key={name}>
              <td className="font-semibold whitespace-nowrap">{name}</td>
              <td className="whitespace-nowrap">{access}</td>
              <td className="text-zinc-500">{why}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The webhook events a GitHub App for factories subscribes to, one per row. */
export function GitHubEvents() {
  return (
    <div className={`${card} overflow-x-auto`}>
      <table className={`${table} [&_td]:align-top`}>
        <thead>
          <tr>
            <th>Event</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {events.map(({ name, why }) => (
            <tr key={name}>
              <td className="font-semibold whitespace-nowrap">{name}</td>
              <td className="text-zinc-500">{why}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
