import { useState } from "react";
import { CopyButton } from "./copy-button.tsx";
import { RevealButton } from "./secret-input.tsx";
import { input } from "./ui.ts";

/**
 * Text to copy, such as a command, in a box with a copy button. Give `secret`
 * when part of the text is one: that part stays hidden until its eye button
 * shows it, and Copy still copies the whole text.
 */
export function Snippet({
  text,
  label,
  command,
  secret,
}: {
  text: string;
  label: string;
  command?: boolean;
  secret?: string;
}) {
  const [shown, setShown] = useState(false);
  const display = secret && !shown ? text.replace(secret, "•".repeat(24)) : text;
  return (
    <div className="flex gap-2">
      <code className={`${input} flex min-w-0 grow items-center gap-2 font-mono`}>
        <span className="grow break-all">
          {command && <span className="select-none text-zinc-500">$ </span>}
          {display}
        </span>
        {secret && (
          <RevealButton shown={shown} onToggle={() => setShown(!shown)} className="-my-1" />
        )}
      </code>
      <CopyButton text={text} label={label} />
    </div>
  );
}
