import { fixCiHowToWork } from "./fix-ci-how-to-work.prompt.ts";

export type FixCiPromptInput = { checks: string; attempt: string };
export type FixCiPrompt = (input: FixCiPromptInput) => string;

export const fixCiPrompt: FixCiPrompt = ({ checks, attempt }) => `# Fix CI

CI is red on your pull request's head commit. This is attempt ${attempt}.

## The failing checks

${checks}

## How to work

- Work in the current directory — the worktree your change is on.
${fixCiHowToWork}
`;
