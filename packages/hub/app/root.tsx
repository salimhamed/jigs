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
          <Toaster richColors position="top-center" />
        </ThemeProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

const navLink = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-3 py-1.5 ${
    isActive
      ? "bg-zinc-100 font-medium dark:bg-zinc-800"
      : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
  }`;

const pages = [
  { to: "/", label: "Home" },
  { to: "/factories", label: "Factories" },
  { to: "/apps", label: "Apps" },
  { to: "/members", label: "Members" },
  { to: "/settings", label: "Settings" },
];

export default function App() {
  const member = useRouteLoaderData<typeof organizationLoader>("routes/organization");
  return (
    <>
      <header className="border-b border-zinc-200 dark:border-zinc-800">
        <div className="mx-auto flex min-h-14 max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2">
          <span className="font-semibold">{member?.organization ?? "jigs hub"}</span>
          <nav className="flex flex-1 flex-wrap gap-1 text-sm">
            {member &&
              pages.map(({ to, label }) => (
                <NavLink key={to} to={to} end={to === "/"} className={navLink}>
                  {label}
                </NavLink>
              ))}
          </nav>
          {member && (
            <Form method="post" action="/sign-out" className="flex items-center gap-2 text-sm">
              <span className="text-zinc-500">{member.user.email}</span>
              <button type="submit" className={quietButton}>
                Sign out
              </button>
            </Form>
          )}
          <ThemeToggle />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
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
    <main className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-xl font-semibold">{message}</h1>
    </main>
  );
}
