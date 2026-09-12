// The half of "How to work" a resumed fix and a rebuilt one state word for
// word the same. Only the first bullet differs: the rebuilt builder is told to
// read the worktree before trusting the diff it was handed, and the resumed one
// already has it.
export const fixCiHowToWork = `- Read the check output before you change anything. Fix the cause, never the
  symptom: deleting or skipping the failing assertion is not a fix.
- Reproduce the failure locally where the repo gives you a way to.
- If the failure is unrelated to your change, say so in the commit message and
  fix it anyway if it is cheap; leave it alone if it is not yours to touch.
- **Commit your fix before you finish.** The push that follows reports the
  commits on the branch, and an uncommitted fix never reaches CI.`;
