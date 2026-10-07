import type { ReactNode } from "react";
import { Link } from "react-router";
import { CopyButton } from "./copy-button.tsx";
import { Hint } from "./hint.tsx";
import { input } from "./ui.ts";

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
          {subtitle && <p className="max-w-3xl text-zinc-500">{subtitle}</p>}
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

/** Facts about a page's subject in one row: "label value · label value". */
export function Details({
  items,
}: {
  items: { label: string; value: ReactNode; hint?: ReactNode; className?: string }[];
}) {
  return (
    <dl className="flex flex-wrap gap-x-8 gap-y-1 text-sm">
      {items.map(({ label, value, hint, className }) => (
        <div key={label} className="flex gap-1.5">
          <dt className="text-zinc-500">{hint ? <Hint label={label} tip={hint} /> : label}</dt>
          <dd className={className}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A URL to paste into a provider's settings: its label, the read-only value
 * with a Copy button, and where it goes when `children` says.
 */
export function UrlRow({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: ReactNode;
}) {
  return (
    <div className="grid gap-x-4 gap-y-1 sm:grid-cols-[8rem_1fr]">
      <span className="text-sm text-zinc-500 sm:pt-1.5">{label}</span>
      <div className="min-w-0 space-y-1">
        <div className="flex gap-2">
          <input
            readOnly
            value={value}
            aria-label={label}
            onFocus={(event) => event.target.select()}
            className={`${input} min-w-0 grow font-mono`}
          />
          <CopyButton text={value} label={label} />
        </div>
        {children && <p className="text-sm text-zinc-500">{children}</p>}
      </div>
    </div>
  );
}
