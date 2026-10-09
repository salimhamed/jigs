import { redirect } from "react-router";
import { getSession, signInWithGitHub } from "../auth.server.ts";
import { GitHubButton } from "../components/github-button.tsx";
import type { Route } from "./+types/sign-in.ts";

export async function loader({ context, request }: Route.LoaderArgs) {
  if (await getSession(context, request)) throw redirect("/");
  return { error: new URL(request.url).searchParams.get("error") };
}

export function action({ context }: Route.ActionArgs) {
  return signInWithGitHub(context, { callbackURL: "/", errorCallbackURL: "/sign-in" });
}

export default function SignIn({ loaderData }: Route.ComponentProps) {
  return (
    <div className="mx-auto max-w-sm space-y-4 pt-16">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      {loaderData.error === "NOT_INVITED" ? (
        <p className="text-red-600 dark:text-red-400">
          This hub is invite-only, and the email on your GitHub account has no invitation. Ask an
          admin of your Organization for an invite link.
        </p>
      ) : loaderData.error ? (
        <p className="text-red-600 dark:text-red-400">Sign-in failed ({loaderData.error}).</p>
      ) : (
        <p className="text-zinc-500">Members sign in with their GitHub account.</p>
      )}
      <GitHubButton>Sign in with GitHub</GitHubButton>
    </div>
  );
}
