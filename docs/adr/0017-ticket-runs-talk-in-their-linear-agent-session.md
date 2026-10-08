# A ticket run talks to people only in its own Linear agent session

Status: accepted

A ticket run asked its questions and left its notes as ordinary issue
comments, and the next human comment on the ticket woke it. That needed a
comment cursor, a record of every comment the run posted, a hidden
"needs human" marker hook for `jigs status`, and a rule that session comments
never answer a halt ([0016](./0016-linear-agent-conversations.md)). Meanwhile
Linear's agent panel already gives each exchange a thread, a reply box, a
working state and a stop button. So a ticket run now talks to people only in
one Linear agent session, and jigs never writes or reads an ordinary comment.
This replaces the ticket claim as a wake channel and the needs-human marker in
[0003](./0003-webhook-ingress-resource-scoped-tokens.md), the comment reading
in [0009](./0009-factory-identity-per-provider.md), and the single hook and
the halt-comment rule in [0016](./0016-linear-agent-conversations.md).

- **One session per run, opened at the claim.** `acquireTicket` takes the
  ticket's claim, then opens a session on the issue with
  `agentSessionCreateOnIssue`, or takes the one the run was started from
  (`session`). It sets the run's dashboard link, which an app-opened session
  needs to leave `pending`, and posts a `Working on <identifier>` thought. The
  panel shows the run working from its start, and Stop works for its whole
  life, not only while it asks.
- **Two hooks: owning and listening.** The run holds
  `linear:session:<installationName>:<sessionId>` for its whole life and never
  waits on it: owning it is the one-run-per-session lock and how the service
  finds the run, as for a conversation. It holds
  `linear:listening:<installationName>:<sessionId>` only while it reads the
  session: in a halt, or in a conversation. One hook could not do both, since
  the service must tell a run that is asking from one that is working, and a
  wake on a hook the run is not waiting on queues a replay for nothing. The
  listening hook is also what `jigs status` shows as the wait.
- **Questions are elicitations; anyone answers.** `haltForHuman` posts the
  halt as an `elicitation` that mentions the operator (or the creator), the
  assignee and the halt's `mention` emails as Linear profile links, which
  Linear turns into real mentions with inbox notifications. Every message in
  the session the run has not read yet answers it, from whoever wrote it, each
  prefixed with its author's name, including messages sent before the
  question. The claim carries the consumed prompt ids, as a conversation does.
- **A mid-run message waits for the next question.** A message sent while the
  run holds the session but is not listening gets the thought "I'm working and
  can't take instructions mid-run; I'll ask here if I need you. Use Stop to end
  the run." and is read at the run's next question. If the run never asks
  again, it is never read. Steering an agent mid-task would need every harness
  to take input mid-turn and every workflow to decide what a message means
  there; neither is worth it for a run that asks when it is unsure.
- **Stop is `jigs cancel`.** Nothing in a ticket run takes a stop, so the
  service's existing fallback cancels the run after its grace period and posts
  `Stopped.`. Whatever a cancel leaves behind is accepted: the ticket's status
  is unchanged, unpushed commits stay in the retained worktree, and resources
  release under the cancel rule. If that grows annoying, the fix is a tidier
  cancel for every path, not a second stop path for tickets.
- **Notes are responses followed by "Still working."** `noteOnTicket` posts a
  note as a `response`, because Linear notifies the people a response mentions
  and does not notify those a thought mentions (checked live). A response ends
  the app's turn, so a note that does not end the run is followed by a
  `Still working.` thought, which keeps the session active and Stop working.
  A note with `run: "ended"` is the session's last activity, a `response`
  whether the run succeeded or failed. It is never an `error`: Linear shows a
  Retry button on a session that ended in an error, and Retry from a finished
  ticket run leaves the session stuck thinking, since nothing listens after
  the run ends (seen live). A conversation keeps its errors, because there
  Retry is a new message the conversation reads. A person's message puts the session back to
  `pending`, so a halt that takes an answer posts a short thought to make it
  active again before the run's later notes.
- **A run waiting on people keeps its session awaiting input.** Linear marks
  a session `stale` after about 30 minutes with no agent activity, and a stale
  session hides Stop (seen live). A ticket run waiting on its pull request's
  approval, CI and merge is quiet for hours, so its session went stale. A
  session in `awaitingInput` after an elicitation does not go stale (35 minutes
  observed), though Linear shows no Stop while it awaits input (checked live).
  So a note with `run: "waiting"` is posted as an
  `elicitation`, which still notifies its mentions, with no `Still working.`
  after it. The recipe posts one when the pull request opens, saying to comment
  on the pull request to change anything or close it to stop the run, and for
  every needs-a-person note while it
  follows the pull request; it also adds the pull request to the session's
  `externalUrls`, which is how Linear's docs say to show one. The run does not
  read replies to such a note. The service tells a message to a run that holds
  the session but is not listening apart by the app's newest activity: one
  newer than the message means the run already took it (a reply to a halt that
  landed as the halt stopped listening), so nothing is posted; an elicitation
  means the run waits on people, since a halt always listens, so the service
  replies with an elicitation, "I can't take instructions here while I wait;
  my earlier message says where to act.", which keeps the session awaiting
  input (it only knows the run waits, not on what); anything else gets the "I'm working" thought.
  Rejected: a background loop posting thoughts to keep the session fresh (a
  timer per run for a display quirk). Accepted gap: a build that runs over 30
  minutes before the pull request opens can still go stale; a message in the
  session gets the service's "I'm working" thought, which brings Stop back for
  a while, and `jigs cancel` always ends the run.
- **Sessions with no human creator start nothing.** Linear sends the app a
  `created` event for a session it opened itself, with no creator. The
  `linear.agentSessions` source starts no run for it, and the hub posts no
  "Received" acknowledgement. This also skips sessions that automation opened
  without a person; there is no other way to tell the factory's own sessions
  apart, and no such use is known. A message in such a session that no run
  holds gets a final "This conversation has ended." response, once per
  message, when the app's newest activity is a response, which only an ended
  ticket run leaves; without it Linear showed "Thinking…" forever, and it has
  no API to close a session to input.
- **The comment wake is gone.** Linear `Comment` events wake nothing, and
  nothing wakes a ticket claim. `jigs poke` reaches a listening hook (a halted
  ticket run, or a conversation waiting for its next message) and pull-request
  and Slack waits, never the claim. The needs-human marker hook, the comment
  cursor and the posted-comment ids are removed. Agents using the Linear MCP may still post ordinary
  comments as the app; nothing reads them.

## Consequences

- A workflow's questions and notes need a claim, and every way out of a ticket
  run should end its session with an `ended` note, or Linear shows the run
  working after it ended. The `linear-ticket-to-pr` recipe ends it with
  "Merged <link>.", its stop notes (a closed pull request gets "Stopped: the
  pull request was closed, so it won't be merged." and the branch, which it
  pushes; the run then completes, since the release policy keeps a dirty
  worktree or unmerged local commits), or "The
  run failed. The run's page has the error." for an unexpected error. A cancelled run posts nothing beyond the
  service's `Stopped.`.
- A run started from a session talks in that session; one started any other
  way opens a new one, so one issue can show several sessions over time, one
  per run.
- Rejected: one hook for owning and listening (the service could not tell
  asking from working); opening the session only at the first question (no
  working state and no Stop before it); posting notes as thoughts (they notify
  no one); delivering mid-run messages into the agent (steering); a graceful
  stop for ticket runs (a second stop path); keeping comment waking beside the
  session (two channels for one exchange).
