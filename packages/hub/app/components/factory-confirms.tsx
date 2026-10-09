import type { ReactNode } from "react";
import { ConfirmForm } from "./confirm-form.tsx";

/** Re-issues a factory's token once confirmed, then shows the new token to set. */
export function ReissueTokenButton({
  factory,
  className,
  children,
}: {
  factory: { id: string; name: string };
  className: string;
  children: ReactNode;
}) {
  return (
    <ConfirmForm
      action="/factories/new"
      fields={{ intent: "reissue", factoryId: factory.id }}
      title={`Re-issue token for ${factory.name}?`}
      body={`The current token stops working right away. ${factory.name} stays offline until its environment has the new one.`}
      confirmLabel="Re-issue token"
      className={className}
    >
      {children}
    </ConfirmForm>
  );
}

const and = new Intl.ListFormat("en", { type: "conjunction" });

/** Removes a factory once confirmed, saying what it loses, then shows the factory list at `returnTo`. */
export function RemoveFactoryButton({
  factory,
  returnTo = "/factories",
  className,
  children,
}: {
  factory: { id: string; name: string; appNames: string[]; unconfirmed: number };
  returnTo?: string;
  className: string;
  children: ReactNode;
}) {
  const { appNames, unconfirmed } = factory;
  const disconnected =
    appNames.length > 0 ? ` and it's disconnected from ${and.format(appNames)}` : "";
  const dropped =
    unconfirmed === 0
      ? ""
      : ` Its ${unconfirmed} unconfirmed ${unconfirmed === 1 ? "event is" : "events are"} dropped.`;
  return (
    <ConfirmForm
      action={`/factories/${factory.id}`}
      fields={{ intent: "remove", returnTo }}
      title={`Remove ${factory.name}?`}
      body={`Its token stops working${disconnected}.${dropped}`}
      confirmLabel="Remove factory"
      destructive
      className={className}
    >
      {children}
    </ConfirmForm>
  );
}
