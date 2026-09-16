// The World the e2e boot check runs the built bundle against: enough of one
// for the service to start and become ready, and nothing that touches a
// database. The SDK's filesystem World refuses to start from a bundle, and a
// Postgres one needs a Postgres; the check is about the service's own boot
// and exit, not about either. @workflow/core loads WORKFLOW_TARGET_WORLD with
// require() and calls the exported function.
module.exports = () => ({
  // SPEC_VERSION_CURRENT in @workflow/world, the version world-postgres runs.
  specVersion: 3,
  createQueueHandler: () => async () => new Response("ok"),
  // The startup nudge sweep enumerates held hooks: an empty page is a World
  // with nothing parked on a pull request.
  hooks: { list: async () => ({ data: [], cursor: null, hasMore: false }) },
  start: async () => {},
  close: async () => {},
});
