import { Outlet } from "react-router";
import { requireMember } from "../auth.server.ts";
import type { Route } from "./+types/organization.ts";

// Every page under here needs a member of an Organization; the shell's nav reads this.
export async function loader({ context, request }: Route.LoaderArgs) {
  const { headers, user, role } = await requireMember(context, request);
  const organization = await context.auth.api.getFullOrganization({ headers });
  return { user: { name: user.name, email: user.email }, role, organization: organization?.name };
}

export default function Organization() {
  return <Outlet />;
}
