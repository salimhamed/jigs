import { warningText } from "./ui.ts";

/** Where an app is installed, and the name factories use for it once an admin gives one. */
export interface InstallationLabel {
  account: string;
  installationName: string | null;
}

/** An installation's name, or that it needs one. */
export function InstallationName({ name }: { name: string | null }) {
  return name === null ? (
    <span className={warningText}>Needs a name</span>
  ) : (
    <span className="font-mono">{name}</span>
  );
}

/** An app's installations by name, with each account beside it or, without `withAccounts`, on hover. */
export function InstallationNames({
  installations,
  withAccounts = false,
}: {
  installations: InstallationLabel[];
  withAccounts?: boolean;
}) {
  if (installations.length === 0) return <span className="text-zinc-500">Not installed</span>;
  return installations.map(({ account, installationName }, index) => (
    <span key={account} title={withAccounts ? undefined : account}>
      {index > 0 && ", "}
      <InstallationName name={installationName} />
      {withAccounts && <span className="text-zinc-500"> ({account})</span>}
    </span>
  ));
}
