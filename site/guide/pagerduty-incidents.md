# Triage a PagerDuty incident

A workflow can read a PagerDuty incident, have an agent look into it, and add
what the agent found to the incident as a note. It needs the factory's
[PagerDuty app](/guide/pagerduty) set up first.

## The incident steps

`#jigs/steps` has two PagerDuty steps:

- `fetchIncidentSnapshot({ installationName, incidentId })` reads the incident: its number, title,
  status, urgency, creation time and URL, and its service, assignees and
  escalation policy, each with an id, a name and a link. Later steps in the run
  work from this copy; a run that resumes reads the incident afresh.
- `postIncidentNote({ installationName, incidentId, content })` adds a note and
  returns its `noteId`. The note is attributed to the from user set on the
  installation in the hub, and ends in a line such
  as `Run wrun_01K…`, so a responder can find the run with `jigs status`.
  PagerDuty shows markup as literal text, so write plain sentences.

`postIncidentNote` is tried only once. If PagerDuty's reply is lost, the note
may already have been added, and a retry could add it twice. So a failed post
fails the step, and the run with it unless the workflow catches the error.

The steps read and write through the PagerDuty installation they name. An
agent that needs more than the snapshot, such as alerts or log entries, gets
it from PagerDuty's MCP server, acting as the same app.

## An observer workflow

This workflow looks at an incident and adds a note. It changes nothing else on
the incident. Save it as `workflows/incident-triage/incident-triage.ts`:

```ts
// workflows/incident-triage/incident-triage.ts
import {
  defineWorkflow,
  harnesses,
  models,
  pagerdutyMcp,
  type WorkflowInputs,
} from "@jigs-ai/jigs";
import { z } from "zod";
import { runAgent } from "#jigs/routines";
import { createRunDirectory, fetchIncidentSnapshot, postIncidentNote } from "#jigs/steps";

const inputs = z.object({ installationName: z.string().min(1), incident: z.string().min(1) });

const agents = {
  triager: harnesses.pi(models.openaiCodex("gpt-5.5"), {
    pagerduty: { installationName: "pagerduty-acme" },
    mcpServers: {
      pagerduty: pagerdutyMcp({
        tools: ["get_incident", "list_alerts_from_incident", "list_log_entries"],
      }),
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

  const { installationName } = input;
  const incident = await fetchIncidentSnapshot({ installationName, incidentId: input.incident });
  if (incident.status === "resolved") return { skipped: "already resolved" };

  const directory = await createRunDirectory();
  const triage = await runAgent({
    harness: agents.triager,
    cwd: directory,
    prompt: [
      `Triage PagerDuty incident #${incident.number} (${incident.id}): ${incident.title}.`,
      `Service: ${incident.service.name}. Urgency: ${incident.urgency}. Opened ${incident.createdAt}.`,
      "Use the PagerDuty tools to read its alerts and log entries.",
      "Do not change the incident. Say what is happening, the likely cause and one next step.",
    ].join("\n"),
    output: findings,
  });

  const note = await postIncidentNote({
    installationName,
    incidentId: incident.id,
    content: [
      `Summary: ${triage.output.summary}`,
      `Likely cause: ${triage.output.likelyCause}`,
      `Suggested next step: ${triage.output.nextStep}`,
    ].join("\n"),
  });
  return { noteId: note.noteId, ...triage.output };
}

export default defineWorkflow({
  inputs,
  requires: { agents, integrations: ["pagerduty"] },
  workflow: incidentTriage,
});
```

### The agent's PagerDuty access

The triager is a [Pi agent](/guide/models-and-harnesses#pi). Its
`pagerduty` option names the installation it acts through, and jigs gives
it that installation's token from the hub when it starts. A harness is fixed
in code, so name the installation your trigger passes. `pagerdutyMcp()`
connects it to PagerDuty's hosted MCP server with that token, and the `tools`
list narrows what it may call to the reads it needs. See
[Linear and PagerDuty access for agents](/guide/models-and-harnesses#provider-access).

The token belongs to the app, not a person, so the agent can read and update
incidents and read users, but tools that answer for a user, such as
`get_user_data`, do not work. Past and related incidents are left out: they
failed with a permission error on an account tested with this workflow.

### Start it from each new incident

[Register `incident-triage` in the factory](/guide/build-a-workflow#_3-register-the-workflow)
and give it an
[event trigger](/guide/configuration#triggers) on the `pagerduty.incidents`
source, which starts one run for each new incident on the services you name:

```ts
// jigs.config.ts
import { defineFactory, pagerduty } from "@jigs-ai/jigs";

export default defineFactory({
  hub: { url: "https://hub.example.com" },
  service: { port: 8990, dashboardPort: 9090 },
  workflows: {
    "incident-triage": () => import("./workflows/incident-triage/incident-triage.ts"),
  },
  triggers: {
    "triage-checkout": {
      active: process.env.TRIAGE_CHECKOUT_ACTIVE === "true",
      workflow: "incident-triage",
      source: pagerduty.incidents({ installationName: "pagerduty-acme", services: ["PABC123"] }),
    },
  },
});
```

Each run gets the incident's id as `incident`, and the trigger's installation
as `installationName`. Every new incident starts a run,
even one acknowledged or resolved before the service saw it, which is why the
workflow checks the status in its snapshot and skips one that is already
resolved. Rebuild and start the service with `pnpm exec jigs up`.

A run starts within seconds of PagerDuty's `incident.triggered` event, which
reaches the service through the [hub](/guide/configuration#hub). An incident
whose event arrives twice still starts one run.

To try the workflow by hand, start a run with an incident's id, the part of its
URL after `/incidents/`:

```sh
pnpm exec jigs run incident-triage --input installationName=pagerduty-acme --input incident=Q1ABCDEFGHIJKL
```

Before the run starts, preflight checks that Pi is installed and that the
agent's installation is on the hub. The snapshot's installation comes from the
run's inputs, so the run's first step checks it. The agent step checks
PagerDuty's MCP server with the agent's token before the agent starts.

Follow the run with `pnpm exec jigs watch`. When it finishes, the note is on the
incident's timeline.
