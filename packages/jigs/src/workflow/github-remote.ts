const REMOTE_PATTERNS = [
  /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/,
  /^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/,
  /^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/,
];

export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  for (const pattern of REMOTE_PATTERNS) {
    const match = pattern.exec(url.trim());
    const [, owner, repo] = match ?? [];
    if (owner !== undefined && repo !== undefined && !repo.includes("/")) {
      return { owner, repo };
    }
  }
  return null;
}

/** The repository a binding's remote names, which the factory config schema holds to GitHub. */
export function bindingRepository(remote: string): { owner: string; repo: string } {
  const repository = parseGithubRemote(remote);
  if (repository === null) throw new Error(`${remote} is not a GitHub repository URL`);
  return repository;
}
