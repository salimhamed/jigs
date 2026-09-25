// The implementation lives in workflow/, where the workflow bundle can reach it. Re-exporting preserves
// the shared class identity for the CLI, service, providers and steps.
export { JigsError } from "./workflow/errors.ts";
