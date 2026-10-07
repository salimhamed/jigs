import { CheckCircle2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Form, Link, useFetcher } from "react-router";
import { isUuid } from "../../src/apps.ts";
import { isUniqueViolation } from "../../src/db/database.ts";
import { addFactory, reissueToken } from "../../src/factories.ts";
import { requireAdmin, requireMember } from "../auth.server.ts";
import { useActionToast } from "../components/action-toast.tsx";
import { CopyButton } from "../components/copy-button.tsx";
import { PageHeader, StatusDot } from "../components/page.tsx";
import {
  button,
  card,
  input,
  link,
  quietButton,
  secondaryButton,
  warningText,
} from "../components/ui.ts";
import { connectCommand, readFactory } from "../factories.server.ts";
import type { Route } from "./+types/new-factory.ts";
import type { loader as lastSeenLoader } from "./factory-last-seen.ts";

export async function loader({ context, request }: Route.LoaderArgs) {
  const { role } = await requireMember(context, request);
  return { isAdmin: role === "admin" };
}

// Re-issuing a token from another page posts here too, so both show the same connect view.
export async function action({ context, request }: Route.ActionArgs) {
  const admin = await requireAdmin(context, request);
  if ("error" in admin) return admin;
  const { organizationId } = admin;
  const form = await request.formData();
  if (form.get("intent") === "reissue") {
    const factoryId = String(form.get("factoryId"));
    const factory = isUuid(factoryId)
      ? await readFactory(context, organizationId, factoryId)
      : null;
    const token =
      factory && (await reissueToken(context.db, context.waiters, organizationId, factoryId));
    if (!factory || !token) return { error: "That factory is gone." };
    // Stamped after re-issuing, so a poll with the old token cannot count as connecting.
    return {
      connect: {
        id: factory.id,
        name: factory.name,
        command: connectCommand(context, token),
        issuedAt: new Date().toISOString(),
      },
    };
  }
  const name = String(form.get("name") ?? "").trim();
  if (!name) return { error: "Name the factory." };
  try {
    const { factory, token } = await addFactory(context.db, organizationId, name);
    return {
      connect: {
        id: factory.id,
        name,
        command: connectCommand(context, token),
        issuedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    if (isUniqueViolation(error)) return { error: `A factory is already named ${name}.` };
    throw error;
  }
}

export default function NewFactory({ loaderData, actionData }: Route.ComponentProps) {
  const connect = actionData && "connect" in actionData ? actionData.connect : undefined;
  useActionToast(actionData && "error" in actionData ? actionData : undefined);
  if (connect) return <ConnectFactory key={connect.command} factory={connect} />;
  return (
    <div className="space-y-6">
      <PageHeader title="Add a factory" parent={{ to: "/factories", label: "Factories" }} />
      {loaderData.isAdmin ? (
        <Form method="post" className="max-w-xl space-y-4">
          <label className="flex flex-col gap-1 text-sm">
            Name
            <input name="name" required autoComplete="off" className={input} />
            <span className="text-zinc-500">
              Shown in the factory list. You can rename it later.
            </span>
          </label>
          <div className="flex gap-2">
            <button type="submit" className={button}>
              Create and get command
            </button>
            <Link to="/factories" className={quietButton}>
              Cancel
            </Link>
          </div>
        </Form>
      ) : (
        <p className="text-zinc-500">Only an admin can add a factory.</p>
      )}
    </div>
  );
}

const CHECK_EVERY_MS = 5_000;

/** The one-time connect command, and whether the factory has connected with it yet. */
function ConnectFactory({
  factory,
}: {
  factory: { id: string; name: string; command: string; issuedAt: string };
}) {
  const lastSeen = useFetcher<typeof lastSeenLoader>();
  const url = `/factories/${factory.id}/last-seen`;
  const lastSeenAt = lastSeen.data?.lastSeenAt;
  const connected = lastSeenAt != null && lastSeenAt > factory.issuedAt;
  const [now, setNow] = useState(Date.now);
  const [nextCheck, setNextCheck] = useState(() => Date.now() + CHECK_EVERY_MS);
  const { load } = lastSeen;

  useEffect(() => {
    if (connected) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [connected]);

  useEffect(() => {
    if (connected || now < nextCheck) return;
    load(url);
    setNextCheck(now + CHECK_EVERY_MS);
  }, [connected, now, nextCheck, load, url]);

  const checkNow = () => {
    load(url);
    setNextCheck(Date.now() + CHECK_EVERY_MS);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Connect ${factory.name}`}
        subtitle={
          <>
            Run this command in the directory of <strong>{factory.name}</strong>, on the machine
            where it runs.
          </>
        }
        parent={{ to: "/factories", label: "Factories" }}
      />
      <div className="max-w-3xl space-y-2">
        <div className={`${card} flex items-center gap-3 p-3`}>
          <code className="grow break-all text-sm">
            <span className="select-none text-zinc-500">$ </span>
            {factory.command}
          </code>
          <CopyButton text={factory.command} label="Command" />
        </div>
        <p className={`text-sm ${warningText}`}>
          The token is shown once. Copy it before leaving this page.
        </p>
      </div>
      {connected ? (
        <p className="flex items-center gap-2 text-sm">
          <CheckCircle2 className="size-4 text-emerald-500" />
          {factory.name} is connected.
          <Link to={`/factories/${factory.id}`} className={link}>
            Open its page
          </Link>
        </p>
      ) : (
        <div className="flex items-center gap-3 text-sm text-zinc-500">
          <StatusDot online={false} />
          Waiting for {factory.name} to connect…
          <button type="button" onClick={checkNow} className={quietButton}>
            <RefreshCw className={`size-4 ${lastSeen.state === "loading" ? "animate-spin" : ""}`} />
            Check now ({Math.max(0, Math.ceil((nextCheck - now) / 1000))}s)
          </button>
        </div>
      )}
      <Link to="/factories" className={secondaryButton}>
        Back to factories
      </Link>
    </div>
  );
}
