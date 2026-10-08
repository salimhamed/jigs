import { Form } from "react-router";
import { attempt, requireMember } from "../auth.server.ts";
import { useActionToast } from "../components/action-toast.tsx";
import { PageHeader, SettingRow } from "../components/page.tsx";
import { card, input, secondaryButton } from "../components/ui.ts";
import type { Route } from "./+types/settings.ts";

export async function loader({ context, request }: Route.LoaderArgs) {
  const { headers, role } = await requireMember(context, request);
  const organization = await context.auth.api.getFullOrganization({ headers });
  return { isAdmin: role === "admin", name: organization?.name ?? "" };
}

export async function action({ context, request }: Route.ActionArgs) {
  const { headers } = await requireMember(context, request);
  const name = String((await request.formData()).get("name") ?? "").trim();
  if (!name) return { error: "Name the Organization." };
  return attempt(() => context.auth.api.updateOrganization({ headers, body: { data: { name } } }));
}

export default function Settings({ loaderData, actionData }: Route.ComponentProps) {
  useActionToast(actionData);
  return (
    <div className="space-y-6">
      <PageHeader title="Settings" />
      <div className={`${card} max-w-4xl`}>
        <SettingRow label="Organization name" hint="Shown at the top of every page.">
          <Form method="post" className="flex flex-wrap gap-2">
            <input
              name="name"
              required
              defaultValue={loaderData.name}
              disabled={!loaderData.isAdmin}
              aria-label="Organization name"
              className={`${input} min-w-0 grow`}
            />
            {loaderData.isAdmin && (
              <button type="submit" className={secondaryButton}>
                Save
              </button>
            )}
          </Form>
        </SettingRow>
      </div>
    </div>
  );
}
