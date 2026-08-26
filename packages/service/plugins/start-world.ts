// Docs say to wrap with defineNitroPlugin from "nitro/~internal/runtime/plugin",
// but that subpath isn't exported by nitro 3.0.260610-beta; the helper is an
// identity function, so a plain default export works.
export default async function startWorld() {
  const { getWorld } = await import("workflow/runtime");
  await getWorld().start?.();
  console.log(
    `[service] world started: ${process.env.WORKFLOW_TARGET_WORLD ?? "local (default)"}`,
  );
}
