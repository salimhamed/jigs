import { Form } from "react-router";
import { attempt, requireMember } from "../auth.server.ts";
import { useActionToast } from "../components/action-toast.tsx";
import { PageHeader } from "../components/page.tsx";
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
      <Form
        method="post"
        className={`${card} flex max-w-3xl flex-wrap items-center gap-x-6 gap-y-2 p-5`}
      >
        <label htmlFor="organization-name" className="w-48 text-sm text-zinc-500">
          Organization name
        </label>
        <input
          id="organization-name"
          name="name"
          required
          defaultValue={loaderData.name}
          disabled={!loaderData.isAdmin}
          className={`${input} min-w-48 grow`}
        />
        {loaderData.isAdmin && (
          <button type="submit" className={secondaryButton}>
            Save
          </button>
        )}
      </Form>
    </div>
  );
}
