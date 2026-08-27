// The documented defineNitroPlugin subpath doesn't exist at nitro 3.0.260610-beta;
// a plain default export works.
export default async function startWorld() {
  const { getWorld } = await import("workflow/runtime");
  await getWorld().start?.();
  // Startup reconciliation of suspended runs (poke every held hook) would
  // live here; fast-follow — `jigs poke <run>` covers the gap for now.
  console.log(
    `[service] world started: ${process.env.WORKFLOW_TARGET_WORLD ?? "local (default)"}`,
  );
}
