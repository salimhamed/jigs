import type { ReactNode } from "react";
import { Form } from "react-router";

/** A one-button form that posts `fields` once the person confirms `question`. */
export function ConfirmForm({
  action,
  fields,
  question,
  className,
  children,
}: {
  action?: string;
  fields: Record<string, string>;
  question: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <Form
      method="post"
      action={action}
      onSubmit={(event) => {
        if (!confirm(question)) event.preventDefault();
      }}
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button type="submit" className={className}>
        {children}
      </button>
    </Form>
  );
}
