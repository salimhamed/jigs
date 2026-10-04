import { KeyRound, Trash2 } from "lucide-react";
import { Form, Link } from "react-router";
import { addFactory, reissueToken, removeFactory } from "../../src/factories.ts";
import { requireMember } from "../auth.server.ts";
import { useActionToast } from "../components/action-toast.tsx";
import { CopyButton } from "../components/copy-button.tsx";
import { Time } from "../components/time.tsx";
import { button, input, quietButton, table } from "../components/ui.ts";
import { connectCommand, listFactories } from "../factories.server.ts";
import type { Route } from "./+types/factories.ts";

export async function loader({ context, request }: Route.LoaderArgs) {
  const { organizationId, role } = await requireMember(context, request);
  return {
    isAdmin: role === "admin",
    factories: await listFactories(context, organizationId),
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  const { organizationId, role } = await requireMember(context, request);
  if (role !== "admin") return { error: "Only an admin can change factories." };
  const form = await request.formData();
  const factoryId = String(form.get("factoryId"));
  const name = String(form.get("name") ?? "").trim();
  switch (form.get("intent")) {
    case "remove":
      await removeFactory(context.db, context.waiters, organizationId, factoryId);
      return { message: `Removed ${name}.` };
    case "reissue": {
      const token = await reissueToken(context.db, context.waiters, organizationId, factoryId);
      if (!token) return { error: "That factory is gone." };
      return { connect: { name, command: connectCommand(context, token) } };
    }
    default: {
      if (!name) return { error: "Name the factory." };
      try {
        const { token } = await addFactory(context.db, organizationId, name);
        return { connect: { name, command: connectCommand(context, token) } };
      } catch (error) {
        if (isUniqueViolation(error)) return { error: `A factory is already named ${name}.` };
        throw error;
      }
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if ((cause as { code?: string }).code === "23505") return true;
  }
  return false;
}

export default function Factories({ loaderData, actionData }: Route.ComponentProps) {
  useActionToast(actionData);
  const connect = actionData && "connect" in actionData ? actionData.connect : undefined;
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Factories</h1>
      {loaderData.isAdmin && (
        <Form method="post" className="flex flex-wrap gap-2">
          <input
            name="name"
            required
            placeholder="Factory name"
            aria-label="Name"
            className={`${input} min-w-64`}
          />
          <button type="submit" className={button}>
            Add factory
          </button>
        </Form>
      )}
      {connect && (
        <div className="space-y-2 rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
          <p className="text-sm">
            Run this where <strong>{connect.name}</strong> runs. The token is shown only now.
          </p>
          <pre className="overflow-x-auto rounded bg-zinc-100 p-2 text-sm dark:bg-zinc-900">
            {connect.command}
          </pre>
          <CopyButton text={connect.command} label="Command" />
        </div>
      )}
      {loaderData.factories.length === 0 ? (
        <p className="text-zinc-500">No factories yet.</p>
      ) : (
        <table className={table}>
          <thead className="text-zinc-500">
            <tr>
              <th>Name</th>
              <th>Last seen</th>
              <th>jigs</th>
              <th>Unconfirmed</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {loaderData.factories.map((factory) => (
              <tr key={factory.id} className="border-t border-zinc-200 dark:border-zinc-800">
                <td>
                  <Link to={`/factories/${factory.id}`} className="underline">
                    {factory.name}
                  </Link>
                </td>
                <td>{factory.lastSeenAt ? <Time iso={factory.lastSeenAt} /> : "never"}</td>
                <td>{factory.lastSeenVersion ?? "—"}</td>
                <td>{factory.unconfirmed}</td>
                <td className="flex justify-end gap-1">
                  {loaderData.isAdmin && (
                    <>
                      <ConfirmForm
                        intent="reissue"
                        factory={factory}
                        question={`Re-issue the token of ${factory.name}? Its current token stops working.`}
                      >
                        <KeyRound className="size-4" />
                        Re-issue token
                      </ConfirmForm>
                      <ConfirmForm
                        intent="remove"
                        factory={factory}
                        question={`Remove ${factory.name} and every message waiting for it?`}
                      >
                        <Trash2 className="size-4" />
                        Remove
                      </ConfirmForm>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ConfirmForm({
  intent,
  factory,
  question,
  children,
}: {
  intent: string;
  factory: { id: string; name: string };
  question: string;
  children: React.ReactNode;
}) {
  return (
    <Form
      method="post"
      onSubmit={(event) => {
        if (!confirm(question)) event.preventDefault();
      }}
    >
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="factoryId" value={factory.id} />
      <input type="hidden" name="name" value={factory.name} />
      <button type="submit" className={quietButton}>
        {children}
      </button>
    </Form>
  );
}
