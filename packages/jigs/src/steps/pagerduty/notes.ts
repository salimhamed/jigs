// PagerDuty shows a note as plain text, so the run is named in words, not a
// hidden marker. Nothing reads a note back: the factory posts it once and a
// lost response means no note rather than two.

import { pagerDutyFor } from "../../providers/pagerduty.ts";
import type { RunMetadata } from "../runtime/run-context.ts";

function renderIncidentNote(content: string, metadata: RunMetadata): string {
  return `${content.trimEnd()}\n\njigs run ${metadata.workflowRunId}`;
}

/**
 * Add a plain-text note to the incident, ending in a line that names the run.
 *
 * @remarks
 * The note is attributed to the from user set on the PagerDuty installation in the hub.
 * PagerDuty shows markup as literal text, so write plain sentences.
 *
 * @group Create and update
 */
export async function postIncidentNote(
  {
    installationName,
    incidentId,
    content,
  }: { installationName: string; incidentId: string; content: string },
  metadata: RunMetadata,
): Promise<{ noteId: string }> {
  const note = await pagerDutyFor(installationName).createNote(
    incidentId,
    renderIncidentNote(content, metadata),
  );
  console.log(`[postIncidentNote] posted note=${note.id} incident=${incidentId}`);
  return { noteId: note.id };
}
