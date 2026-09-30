# Triage a PagerDuty incident

A workflow can read a PagerDuty incident, have an agent look into it, and add
what the agent found to the incident as a note. It needs the factory's
[PagerDuty app](/guide/pagerduty) set up first.

## The incident steps

`#jigs/steps` has two PagerDuty steps:

- `fetchIncidentSnapshot(incidentId)` reads the incident: its number, title,
  status, urgency, creation time and URL, and its service, assignees and
  escalation policy, each with an id, a name and a link. Later steps in the run
  work from this copy; a run that resumes reads the incident afresh.
- `postIncidentNote(incidentId, content)` adds a note and returns its
  `noteId`. The note is attributed to your `from` user and ends in a line such
  as `jigs run wrun_01K…`, so a responder can find the run with `jigs status`.
  PagerDuty shows markup as literal text, so write plain sentences.

`postIncidentNote` is tried only once. If PagerDuty's reply is lost, the note
may already have been added, and a retry could add it twice. So a failed post
fails the step, and the run with it unless the workflow catches the error.

The steps read and write through the factory's PagerDuty app. The app does not
give an agent access to PagerDuty: an agent that needs more than the snapshot,
such as alerts, log entries or past incidents, gets it from the PagerDuty MCP
server.

## An observer workflow

This workflow looks at an incident and adds a note. It changes nothing else on
the incident. Save it as `workflows/incident-triage/incident-triage.ts`:

```ts
// workflows/incident-triage/incident-triage.ts
import { defineWorkflow, harnesses, models, type WorkflowInputs } from "@jigs-ai/jigs";
import { z } from "zod";
import { runAgent } from "#jigs/routines";
import { createRunDirectory, fetchIncidentSnapshot, postIncidentNote } from "#jigs/steps";

const inputs = z.object({ incident: z.string().min(1) });

const agents = {
  triager: harnesses.pi(models.openaiCodex("gpt-5.5"), {
    mcpServers: {
      pagerduty: {
        command: "uvx",
        args: ["pagerduty-mcp"],
        env: { PAGERDUTY_USER_API_KEY: "PAGERDUTY_USER_API_KEY" },
        tools: [
          "get_user_data",
          "get_incident",
          "list_alerts_from_incident",
          "list_log_entries",
          "get_past_incidents",
          "get_related_incidents",
        ],
        probe: { tool: "get_user_data" },
      },
    },
  }),
};

const findings = z.object({
  summary: z.string(),
  likelyCause: z.string(),
  nextStep: z.string(),
});

export async function incidentTriage(input: WorkflowInputs<typeof inputs>) {
  "use workflow";

  const incident = await fetchIncidentSnapshot(input.incident);
  if (incident.status === "resolved") return { skipped: "already resolved" };

  const directory = await createRunDirectory();
  const triage = await runAgent({
    harness: agents.triager,
    cwd: directory,
    prompt: [
      `Triage PagerDuty incident #${incident.number} (${incident.id}): ${incident.title}.`,
      `Service: ${incident.service.name}. Urgency: ${incident.urgency}. Opened ${incident.createdAt}.`,
      "Use the PagerDuty tools to read its alerts, log entries, and related or past incidents.",
      "Do not change the incident. Say what is happening, the likely cause and one next step.",
    ].join("\n"),
    output: findings,
  });

  const note = await postIncidentNote(
    incident.id,
    [
      `Summary: ${triage.output.summary}`,
      `Likely cause: ${triage.output.likelyCause}`,
      `Suggested next step: ${triage.output.nextStep}`,
    ].join("\n"),
  );
  return { noteId: note.noteId, ...triage.output };
}

export default defineWorkflow({
  inputs,
  requires: { agents, integrations: ["pagerduty"] },
  workflow: incidentTriage,
});
```

### The agent's PagerDuty access

The triager is a [Pi agent](/guide/models-and-harnesses#pi) with PagerDuty's
MCP server, which `uvx` runs from PyPI, so install
[uv](https://docs.astral.sh/uv/) on the machine that runs the service. The
server lists read-only tools unless it is started with `--enable-write-tools`,
and the `tools` list narrows what the agent may call to the reads it needs.

The server authenticates with a PagerDuty user API token, separate from the
app's credentials. Create one in the **User Settings** of a PagerDuty user who
can see the incidents, and add it to the factory's `.env`:

```sh
PAGERDUTY_USER_API_KEY=...
```

Each `env` entry maps a variable the server receives to a variable in the
service's environment. A Pi agent gets the variables its MCP servers name,
so the token needs no [`agents.env`](/guide/configuration#agents-env) entry.
An account on the EU service region also maps `PAGERDUTY_API_HOST` to a
variable set to `https://api.eu.pagerduty.com`.

### Run it

[Register `incident-triage` in the factory](/guide/build-a-workflow#_3-register-the-workflow),
then rebuild and start a run with the incident's id, the part of its URL after
`/incidents/`:

```sh
pnpm exec jigs up
pnpm exec jigs run incident-triage --input incident=Q1ABCDEFGHIJKL
```

Before the run starts, preflight checks the PagerDuty app and that Pi is
installed. The agent step checks that the token is set before the agent starts.
Follow the run with `pnpm exec jigs watch`. When it finishes, the note is on the
incident's timeline.
