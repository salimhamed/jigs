import { isUuid } from "../../src/apps.ts";
import { requireMember } from "../auth.server.ts";
import { readFactory, readFactoryApps } from "../factories.server.ts";
import type { Route } from "./+types/factory-apps.ts";

/**
 * A factory's connected and connectable apps, for the connect page, or that
 * it is gone: an error would replace the connect page.
 */
export async function loader({ context, request, params }: Route.LoaderArgs) {
  const { organizationId, role } = await requireMember(context, request);
  const factory = isUuid(params.id) ? await readFactory(context, organizationId, params.id) : null;
  if (!factory) return { gone: true as const };
  return {
    gone: false as const,
    isAdmin: role === "admin",
    ...(await readFactoryApps(context, organizationId, factory.id)),
  };
}
