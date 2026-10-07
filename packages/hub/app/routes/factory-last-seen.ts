import { data } from "react-router";
import { isUuid } from "../../src/apps.ts";
import { requireMember } from "../auth.server.ts";
import { readFactory } from "../factories.server.ts";
import type { Route } from "./+types/factory-last-seen.ts";

/** When a factory last reached the hub, which the connect page polls. */
export async function loader({ context, request, params }: Route.LoaderArgs) {
  const { organizationId } = await requireMember(context, request);
  const factory = isUuid(params.id) ? await readFactory(context, organizationId, params.id) : null;
  if (!factory) throw data(null, { status: 404, statusText: "Not Found" });
  return { lastSeenAt: factory.lastSeenAt };
}
