import { fixCiHowToWork } from "./fix-ci-how-to-work.prompt.ts";

export type FixCiFreshPromptInput = {
  ticket: string;
  brief: string;
  diff: string;
  checks: string;
  attempt: string;
};
export type FixCiFreshPrompt = (input: FixCiFreshPromptInput) => string;

export const fixCiFreshPrompt: FixCiFreshPrompt = ({
  ticket,
  brief,
  diff,
  checks,
  attempt,
}) => `# Fix CI from a rebuilt context

You are the builder for this change, picking it up from its record. CI is red
on your pull request's head commit, and this is attempt ${attempt}. Everything
you need is below: the ticket the change implements, the brief it was built
from, the diff it consists of, and the checks that are failing.

## The ticket

${ticket}

## The brief

${brief}

## The change under review

\`\`\`diff
${diff}
\`\`\`

## The failing checks

${checks}

## How to work

- Work in the current directory — the worktree your change is on. Read the
  files the diff touches before you change any of them: the diff above is the
  summary, the worktree is the truth.
${fixCiHowToWork}
`;
