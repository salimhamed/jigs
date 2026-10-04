import { Form, redirect } from "react-router";
import { attempt, getActiveMember, getSession, mayCreate } from "../auth.server.ts";
import { useActionToast } from "../components/action-toast.tsx";
import { button, input } from "../components/ui.ts";
import type { Route } from "./+types/new-organization.ts";

export async function loader({ context, request }: Route.LoaderArgs) {
  const session = await getSession(context, request);
  if (!session) throw redirect("/sign-in");
  if (await getActiveMember(context, request)) throw redirect("/");
  return {
    email: session.user.email,
    mayCreate: await mayCreate(context, session.user),
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  const name = String((await request.formData()).get("name") ?? "").trim();
  if (!name) return { error: "Name the Organization." };
  const result = await attempt(() =>
    context.auth.api.createOrganization({
      headers: request.headers,
      body: { name, slug: slugify(name) },
    }),
  );
  return result.error ? result : redirect("/");
}

function slugify(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export default function NewOrganization({ loaderData, actionData }: Route.ComponentProps) {
  useActionToast(actionData);
  if (!loaderData.mayCreate) {
    return (
      <div className="mx-auto max-w-sm space-y-4 pt-16">
        <h1 className="text-2xl font-semibold">No Organization</h1>
        <p className="text-zinc-500">
          You are signed in as {loaderData.email}, which is not a member of an Organization on this
          hub. Open the invite link an admin gave you.
        </p>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-sm space-y-4 pt-16">
      <h1 className="text-2xl font-semibold">Create your Organization</h1>
      <p className="text-zinc-500">
        Its apps, factories and members live here. You will be its first admin.
      </p>
      <Form method="post" className="flex gap-2">
        <input name="name" required placeholder="Name" aria-label="Name" className={input} />
        <button type="submit" className={button}>
          Create
        </button>
      </Form>
    </div>
  );
}
