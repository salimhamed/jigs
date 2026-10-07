import { data } from "react-router";
import { isUuid } from "../../src/apps.ts";
import { requireMember } from "../auth.server.ts";
import { readLastSeen } from "../factories.server.ts";
import type { Route } from "./+types/factory-last-seen.ts";

/** When a factory last reached the hub, which the connect page polls. */
export async function loader({ context, request, params }: Route.LoaderArgs) {
  const { organizationId } = await requireMember(context, request);
  const lastSeenAt = isUuid(params.id)
    ? await readLastSeen(context, organizationId, params.id)
    : undefined;
  if (lastSeenAt === undefined) throw data(null, { status: 404, statusText: "Not Found" });
  return { lastSeenAt };
}
