import { redirect } from "react-router";
import type { Route } from "./+types/sign-out.ts";

export async function action({ context, request }: Route.ActionArgs) {
  const { headers } = await context.auth.api.signOut({
    headers: request.headers,
    returnHeaders: true,
  });
  return redirect("/sign-in", { headers });
}

export function loader() {
  return redirect("/");
}
