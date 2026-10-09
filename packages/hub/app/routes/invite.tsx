import { Form, redirect } from "react-router";
import { attempt, findPendingInvitation, getSession, signInWithGitHub } from "../auth.server.ts";
import { GitHubButton } from "../components/github-button.tsx";
import { button } from "../components/ui.ts";
import type { Route } from "./+types/invite.ts";

// Opening the link signed in accepts it: the admin made it for this person.
export async function loader({ context, request, params }: Route.LoaderArgs) {
  const invite = await findPendingInvitation(context, params.id);
  if (!invite) return { invite: null, error: null, signedIn: false };

  let error = new URL(request.url).searchParams.get("error");
  const signedIn = (await getSession(context, request)) !== null;
  if (!error && signedIn) {
    ({ error = null } = await attempt(() =>
      context.auth.api.acceptInvitation({
        headers: request.headers,
        body: { invitationId: params.id },
      }),
    ));
    if (!error) throw redirect("/");
  }
  return { invite, error, signedIn };
}

export function action({ context, params }: Route.ActionArgs) {
  const here = `/invite/${params.id}`;
  return signInWithGitHub(context, { callbackURL: here, errorCallbackURL: here });
}

export default function Invite({ loaderData: { invite, error, signedIn } }: Route.ComponentProps) {
  if (!invite) {
    return (
      <div className="mx-auto max-w-sm space-y-2 pt-16">
        <h1 className="text-2xl font-semibold">Invitation not found</h1>
        <p className="text-zinc-500">
          It was revoked, already used or has expired. Ask an admin for a new link.
        </p>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-sm space-y-4 pt-16">
      <h1 className="text-2xl font-semibold">Join {invite.organization}</h1>
      <p className="text-zinc-500">
        You are invited as {invite.role === "admin" ? "an admin" : "a member"}. Sign in with the
        GitHub account whose email the invitation names.
      </p>
      {error && (
        <p className="text-red-600 dark:text-red-400">
          {error === "NOT_INVITED"
            ? "The email on your GitHub account does not match this invitation."
            : error}
        </p>
      )}
      {signedIn ? (
        <Form method="post" action="/sign-out">
          <button type="submit" className={button}>
            Sign out to use another account
          </button>
        </Form>
      ) : (
        <GitHubButton>Sign in with GitHub</GitHubButton>
      )}
    </div>
  );
}
