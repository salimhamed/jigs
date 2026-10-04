import { Form } from "react-router";
import { attempt, requireMember } from "../auth.server.ts";
import { useActionToast } from "../components/action-toast.tsx";
import { button, input } from "../components/ui.ts";
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
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <Form method="post" className="flex items-end gap-2">
        <label className="flex flex-col gap-1 text-sm">
          Organization name
          <input
            name="name"
            required
            defaultValue={loaderData.name}
            disabled={!loaderData.isAdmin}
            className={input}
          />
        </label>
        {loaderData.isAdmin && (
          <button type="submit" className={button}>
            Save
          </button>
        )}
      </Form>
    </div>
  );
}
