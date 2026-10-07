# A Linear agent session is one Claude conversation held by one run

Status: accepted

With the hub ([0015](./0015-hub.md)), a mention of a factory's Linear app
starts a run, but the run only posted plain issue comments: Linear's agent
panel showed the app working forever, and its reply box and stop button did
nothing. So a run can now hold a **conversation**: one Claude session that
answers in the Linear agent session that started the run, through the routine
`linearAgentConversation`.

- **One run per Linear agent session, for the whole conversation.** The run
  hosts every follow-up turn and parks between them on one hook,
  `linear:session:<installationName>:<sessionId>`, created once and held like a
  ticket claim. Owning that token is the only owner check: a second run fails
  with `ClaimConflictError`. Across factories there is none; the docs say to
  give each conversing factory its own Linear app.
- **Linear is the durable truth for replies.** A wake carries nothing; before
  every wait the run re-reads the session's prompts and takes those whose ids
  it has not consumed. Each turn is its own step and returns the ids it
  consumed, so the cursor moves only when a step succeeds.
- **Replies join, never interrupt.** A reply that arrives while Claude works is
  injected into the live turn through an in-process registry keyed by the same
  token, and the hook is woken too. A reply after an answer runs as the next
  turn in the same Claude session. A reply after the conversation ended gets
  "This conversation has ended; mention @<app> again to start a new one." from
  the service.
- **Stop interrupts gracefully.** The live turn interrupts Claude and drops
  queued replies, and the run posts one `Stopped.` response under a key derived
  from the stop. If neither a live turn nor the parked run answers within 30 s,
  the service cancels the session's runs and posts the same keyed `Stopped.`,
  so only one appears.
- **Minimal output.** One ephemeral status line
  replaced as Claude works, each answer as a `response` and failures as an
  `error`; the run's dashboard is the session's link. No `elicitation`: a
  question is an answer, and the person replies.
- **Idle timeout**: `idleFor`, four hours by default, ends the conversation and
  the run goes on.
- **A crash continues the turn instead of redoing it.** A retried turn resumes
  the Claude transcript, sends only the messages it does not hold yet, and
  tells Claude the service restarted.
- **Claude only, through the Claude Agent SDK.** Its streaming input folds a
  message into the running turn and runs one sent after the result as the next
  turn, and it can interrupt and drop queued input. The AI SDK provider ended
  its stream at the first result, so every Claude step moved to the Agent SDK
  ([0008](./0008-models-and-harnesses.md)) rather than keeping two ways to
  drive Claude. Codex and Pi can join later behind the same driver capability.

## Consequences

- Session comments never answer a ticket halt: a paused ticket run skips any
  comment that belongs to an agent session, including the opening mention.
- The workflow owns the worktree, the issue and delivery; the routine owns the
  turns, cursor, hook, posts, stop, link and idle timeout. A workflow provisions
  its worktree before calling the routine, since the routine needs its `cwd`.
- Known gaps: a stop the conversation does not answer within about 30 s (it
  arrived just as a turn started, before the run reached the routine, or after
  the conversation ended) makes the service cancel the run and post
  `Stopped.`; a cancelled run runs no more workflow code and releases under its
  `onFailure` policy. Replies during tidy-up after the end get no answer; a
  crash right after an answer posted can post it twice; an answer that fails
  every retry is dropped.
- Linear's agent API is a Developer Preview, so every agent-session query lives
  in one provider module.
- Rejected: an owner table or hub enforcement across factories (configuration
  already solves it); a fresh run per reply (loses the worktree and session);
  interrupting on every reply (Claude Code's own default is to queue);
  replaying a crashed turn from scratch (repeats tool work).
