import { type ReactNode, useRef } from "react";
import { Form } from "react-router";
import { button, dangerButton, quietButton } from "./ui.ts";

/**
 * A button that opens a confirmation dialog; confirming posts `fields` to
 * `action`. A destructive confirmation gets a red button.
 */
export function ConfirmForm({
  action,
  fields,
  title,
  body,
  confirmLabel,
  destructive = false,
  className,
  children,
}: {
  action?: string;
  fields: Record<string, string>;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  className: string;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button type="button" className={className} onClick={() => dialog.current?.showModal()}>
        {children}
      </button>
      <dialog
        ref={dialog}
        className="m-auto w-[calc(100%-2rem)] max-w-md rounded-lg text-left border border-zinc-200 bg-white p-6 text-zinc-900 shadow-xl backdrop:bg-black/50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
      >
        <Form
          method="post"
          action={action}
          onSubmit={() => dialog.current?.close()}
          className="space-y-4"
        >
          {Object.entries(fields).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <h2 className="text-lg font-semibold">{title}</h2>
          <div className="text-sm text-zinc-600 dark:text-zinc-400">{body}</div>
          <div className="flex justify-end gap-2">
            <button type="button" className={quietButton} onClick={() => dialog.current?.close()}>
              Cancel
            </button>
            <button type="submit" className={destructive ? dangerButton : button}>
              {confirmLabel}
            </button>
          </div>
        </Form>
      </dialog>
    </>
  );
}
