import { SPEC_VERSION_CURRENT } from "@workflow/world";

// The World the e2e boot check runs the built bundle against: enough of one
// for the service to start and become ready, and nothing that touches a
// database. The SDK's filesystem World refuses to start from a bundle, and a
// Postgres one needs a Postgres; the check is about the service's own boot and
// exit. The v5 runtime loads target Worlds asynchronously as ESM.
export default () => ({
  specVersion: SPEC_VERSION_CURRENT,
  createQueueHandler: () => async () => new Response("ok"),
  // The startup nudge sweep enumerates held hooks: an empty page is a World
  // with nothing parked on a pull request.
  hooks: { list: async () => ({ data: [], cursor: null, hasMore: false }) },
  start: async () => {},
  close: async () => {},
});
