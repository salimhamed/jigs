import { requireMember } from "../auth.server.ts";
import type { Route } from "./+types/home.ts";

export async function loader({ context, request }: Route.LoaderArgs) {
  await requireMember(context, request);
  return { publicUrl: context.config.publicUrl.href };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold">jigs hub</h1>
      <p className="text-zinc-500">
        Factories connect to this hub at <code>{loaderData.publicUrl}</code>.
      </p>
    </div>
  );
}
