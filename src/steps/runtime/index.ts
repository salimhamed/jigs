/**
 * Run directories, resource records and release operations for factory-owned steps.
 * Workflow code normally calls the generated `#jigs/steps` wrappers.
 *
 * A run directory is scratch space owned by one run, kept across waits and retries
 * until released. Resource records help people find what a run created; a record
 * alone never authorizes deletion. The generated `release` step can release early
 * or return a report; the service applies configured release policy when runs end.
 *
 * @module steps/runtime
 * @packageDocumentation
 */

export { releaseRunResources } from "./release.ts";
export { registerResource } from "./resources.ts";
export { dashboardRunUrl } from "./run-context.ts";
export { createRunDirectory, removeRunDirectory } from "./run-directory/index.ts";
