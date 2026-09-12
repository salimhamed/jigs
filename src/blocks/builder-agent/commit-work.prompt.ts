export type CommitWorkPromptInput = Record<string, never>;
export type CommitWorkPrompt = (input: CommitWorkPromptInput) => string;

export const commitWorkPrompt: CommitWorkPrompt = () => `# Commit your work

You are the builder for this change, and you finished without committing. The
branch carries no commits, so the uncommitted work in your current directory is
your implementation — and nothing else has it.

## How to work

- Work in the current directory. It is the git worktree your change is on, on
  the ticket's branch — do not create another one, and do not switch branches.
- Read what is uncommitted, then commit all of it with a clear message that
  says what the change does.
- Do not write new code beyond what committing cleanly requires. This round is
  for committing the work you already did, not for continuing it.
- **Commit before you finish.** The push that follows reports the commits on
  the branch, and this is the last chance the work gets.
`;
