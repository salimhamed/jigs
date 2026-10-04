import manifest from "../package.json" with { type: "json" };

// Inlined at build time, so the service a factory bundles reports the jigs it
// was built from, and the CLI the jigs it was installed as.
export const JIGS_VERSION: string = manifest.version;

// Set by the service on every response; the CLI refuses a service whose
// version differs from its own.
export const VERSION_HEADER = "x-jigs-version";
