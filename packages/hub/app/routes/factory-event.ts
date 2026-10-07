import { data } from "react-router";
import { isUuid } from "../../src/apps.ts";
import { requireMember } from "../auth.server.ts";
import { readEventPayload } from "../factories.server.ts";
import type { Route } from "./+types/factory-event.ts";

/** One event's payload, which the Activity tab loads when its row is expanded. */
export async function loader({ context, request, params }: Route.LoaderArgs) {
  const { organizationId } = await requireMember(context, request);
  const payload =
    isUuid(params.id) && /^\d{1,19}$/.test(params.position)
      ? await readEventPayload(context, organizationId, params.id, BigInt(params.position))
      : null;
  if (payload === null) throw data(null, { status: 404, statusText: "Not Found" });
  return { payload };
}
