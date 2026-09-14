export type AnswerReviewPromptInput = { threads: string };
export type AnswerReviewPrompt = (input: AnswerReviewPromptInput) => string;

export const answerReviewPrompt: AnswerReviewPrompt = ({ threads }) => `# Answer review

Your pull request came back with review comments. Answer them.

## The threads

${threads}

## What to produce

Emit the answers object: one entry per thread listed above, plus a commit
explanation.

- \`threadId\`: the thread's id, exactly as it appears above. Use \`null\` for an
  answer that belongs on the pull request conversation rather than in a thread.
- \`body\`: your reply, as GitHub-flavoured markdown. Address the reviewer's
  actual point. Say what you changed, or why you did not change it — never
  both a hedge and a fix.
- \`commitExplanation\`: when you made a commit, a concise explanation of what
  changed and what validation you ran. Otherwise, \`null\`. Do not use this
  field to summarize answers when no commit was made.

If a comment asks for a code change, make the change and commit it before you
answer, then say so in the reply. If it asks a question, answer the question.
Do not re-explain what you already told the reviewer in an earlier thread.
`;
