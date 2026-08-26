// Only ever called from inside "use step" functions. GITHUB_API_URL override
// is a test seam.

import type { PrRef } from "../suspension/tokens";

export interface PrReview {
  id: number;
  state: string;
  body: string;
  user: string;
  submittedAt: string;
}

export interface PrSnapshot {
  state: "open" | "closed";
  merged: boolean;
  reviews: PrReview[];
}

async function githubGet<T>(path: string): Promise<T> {
  const token = process.env.GITHUB_TOKEN;
  if (token === undefined || token === "") {
    throw new Error("GITHUB_TOKEN is not set");
  }
  const base = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const res = await fetch(`${base}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} on ${path}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export async function fetchPrSnapshot(pr: PrRef): Promise<PrSnapshot> {
  const prPath = `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`;
  const pull = await githubGet<{ state: "open" | "closed"; merged: boolean }>(
    prPath,
  );
  const reviews = await githubGet<
    Array<{
      id: number;
      state: string;
      body: string | null;
      user: { login: string } | null;
      submitted_at: string;
    }>
  >(`${prPath}/reviews?per_page=100`); // unpaginated cap, accepted for v0
  return {
    state: pull.state,
    merged: pull.merged,
    reviews: reviews.map((review) => ({
      id: review.id,
      state: review.state,
      body: review.body ?? "",
      user: review.user?.login ?? "unknown",
      submittedAt: review.submitted_at,
    })),
  };
}
