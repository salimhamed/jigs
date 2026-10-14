import { type ReactNode, useId } from "react";
import { Link } from "react-router";
import { CopyButton } from "./copy-button.tsx";
import { Hint } from "./hint.tsx";
import { card, input } from "./ui.ts";

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
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className={`${card} space-y-4 p-5`}>
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

/** Links to a page's views, such as its tabs, with the one shown underlined. */
export function Tabs({ tabs }: { tabs: { to: string; label: string; current: boolean }[] }) {
  return (
    <nav className="flex gap-6 border-b border-zinc-200 text-sm dark:border-zinc-800">
      {tabs.map(({ to, label, current }) => (
        <Link
          key={label}
          to={to}
          aria-current={current ? "page" : undefined}
          className={`-mb-px border-b-2 pb-2 ${
            current
              ? "border-zinc-900 font-medium dark:border-zinc-100"
              : "border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
          }`}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * A labelled control: the label, then what it is for, then the control. Give
 * `htmlFor` when the control has that id, so clicking the label focuses it.
 */
export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="space-y-0.5">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="block font-medium">
            {label}
          </label>
        ) : (
          <div className="font-medium">{label}</div>
        )}
        {hint && <p className="text-zinc-500">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

/** A setting in a card of settings. */
export function SettingRow({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="p-5">
      <Field label={label} htmlFor={htmlFor} hint={hint}>
        <div className="max-w-xl">{children}</div>
      </Field>
    </div>
  );
}

/** A destructive action in a red box. */
export function DangerRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-red-300 dark:border-red-900">
      <SettingRow label={label} hint={hint}>
        {children}
      </SettingRow>
    </div>
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

/** A URL to paste into a provider's settings, read-only with a Copy button; `children` says where it goes. */
export function UrlRow({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id} hint={children}>
      <div className="flex gap-2">
        <input
          id={id}
          readOnly
          value={value}
          onFocus={(event) => event.target.select()}
          className={`${input} min-w-0 grow font-mono`}
        />
        <CopyButton text={value} label={label} />
      </div>
    </Field>
  );
}
