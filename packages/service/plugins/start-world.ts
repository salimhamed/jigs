// The documented defineNitroPlugin subpath doesn't exist at nitro 3.0.260610-beta;
// a plain default export works.
export default async function startWorld() {
  const { getWorld } = await import("workflow/runtime");
  await getWorld().start?.();
  console.log(
    `[service] world started: ${process.env.WORKFLOW_TARGET_WORLD ?? "local (default)"}`,
  );
}
