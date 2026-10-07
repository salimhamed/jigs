import { data } from "react-router";
import { isUuid } from "../../src/apps.ts";
import { requireMember } from "../auth.server.ts";
import { readEventLog, readFactory } from "../factories.server.ts";
import type { Route } from "./+types/factory-events.ts";

/** The page of a factory's event log before a position, which the Activity tab appends. */
export async function loader({ context, request, params }: Route.LoaderArgs) {
  const { organizationId } = await requireMember(context, request);
  const before = new URL(request.url).searchParams.get("before") ?? "";
  const factory = isUuid(params.id) ? await readFactory(context, organizationId, params.id) : null;
  if (!factory || !/^\d{1,19}$/.test(before)) {
    throw data(null, { status: 404, statusText: "Not Found" });
  }
  return readEventLog(context, factory, BigInt(before));
}
