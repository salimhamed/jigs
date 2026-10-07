import type { ReactNode } from "react";
import { Link } from "react-router";

/** A page's title, with the page it sits under, a one-line summary and its main action. */
export function PageHeader({
  title,
  subtitle,
  parent,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  parent?: { to: string; label: string };
  action?: ReactNode;
}) {
  return (
    <div className="space-y-1">
      {parent && (
        <Link
          to={parent.to}
          className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          {parent.label} /
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="flex items-center gap-3 text-2xl font-semibold">{title}</h1>
          {subtitle && <p className="text-zinc-500">{subtitle}</p>}
        </div>
        {action}
      </div>
    </div>
  );
}

/** A bordered section with a heading, an optional description and an action beside them. */
export function Card({
  title,
  description,
  action,
  danger,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  danger?: boolean;
  children?: ReactNode;
}) {
  return (
    <section
      className={`space-y-4 rounded-lg border p-5 ${
        danger ? "border-red-300 dark:border-red-900" : "border-zinc-200 dark:border-zinc-800"
      }`}
    >
      {(title || action) && (
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            {title && <h2 className="font-semibold">{title}</h2>}
            {description && <p className="text-sm text-zinc-500">{description}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/** Green while a factory is connected, grey otherwise. */
export function StatusDot({ online }: { online: boolean }) {
  return (
    <span
      role="img"
      aria-label={online ? "Connected" : "Not connected"}
      className={`inline-block size-2 shrink-0 rounded-full ${online ? "bg-emerald-500" : "bg-zinc-400 dark:bg-zinc-600"}`}
    />
  );
}
