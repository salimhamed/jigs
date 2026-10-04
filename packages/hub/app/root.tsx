import { LogOut } from "lucide-react";
import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import {
  Form,
  isRouteErrorResponse,
  Links,
  Meta,
  NavLink,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from "react-router";
import { Toaster } from "sonner";
import type { Route } from "./+types/root.ts";
import stylesheet from "./app.css?url";
import { ThemeToggle } from "./components/theme-toggle.tsx";
import { quietButton } from "./components/ui.ts";
import type { loader as organizationLoader } from "./routes/organization.tsx";

export const links: Route.LinksFunction = () => [{ rel: "stylesheet", href: stylesheet }];

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>jigs hub</title>
        <Meta />
        <Links />
      </head>
      <body className="min-h-screen bg-white text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          {children}
          <Toaster richColors />
        </ThemeProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

const navLink = ({ isActive }: { isActive: boolean }) =>
  isActive ? "font-medium" : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100";

export default function App() {
  const member = useRouteLoaderData<typeof organizationLoader>("routes/organization");
  return (
    <>
      <header className="border-b border-zinc-200 dark:border-zinc-800">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-6 px-4">
          <span className="font-semibold">{member?.organization ?? "jigs hub"}</span>
          <nav className="flex flex-1 gap-4 text-sm">
            {member && (
              <>
                <NavLink to="/" end className={navLink}>
                  Home
                </NavLink>
                <NavLink to="/factories" className={navLink}>
                  Factories
                </NavLink>
                <NavLink to="/members" className={navLink}>
                  Members
                </NavLink>
                <NavLink to="/invites" className={navLink}>
                  Invites
                </NavLink>
                <NavLink to="/settings" className={navLink}>
                  Settings
                </NavLink>
              </>
            )}
          </nav>
          {member && (
            <Form method="post" action="/sign-out" className="flex items-center gap-2 text-sm">
              <span className="text-zinc-500">{member.user.email}</span>
              <button type="submit" aria-label="Sign out" className={quietButton}>
                <LogOut className="size-4" />
              </button>
            </Form>
          )}
          <ThemeToggle />
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">
        <Outlet />
      </main>
    </>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : "Something went wrong";
  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-xl font-semibold">{message}</h1>
    </main>
  );
}
