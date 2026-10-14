import { Eye, EyeOff } from "lucide-react";
import { type ComponentProps, type CSSProperties, useState } from "react";
import { input } from "./ui.ts";

/** A button that shows or hides a secret. */
export function RevealButton({
  shown,
  onToggle,
  className = "",
}: {
  shown: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const Icon = shown ? EyeOff : Eye;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={shown ? "Hide secret" : "Show secret"}
      aria-pressed={shown}
      className={`rounded p-1 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 ${className}`}
    >
      <Icon className="size-4" />
    </button>
  );
}

/** A secret field, hidden until its eye button shows it. */
export function SecretInput({ className = "", ...props }: ComponentProps<"input">) {
  const [shown, setShown] = useState(false);
  return (
    <div className={`relative ${className}`}>
      <input
        {...props}
        type={shown ? "text" : "password"}
        autoComplete="off"
        className={`${input} w-full pr-9`}
      />
      <RevealButton
        shown={shown}
        onToggle={() => setShown(!shown)}
        className="absolute top-1/2 right-1.5 -translate-y-1/2"
      />
    </div>
  );
}

/** A multi-line secret, such as a private key, hidden until its eye button shows it. */
export function SecretTextarea({ className = "", ...props }: ComponentProps<"textarea">) {
  const [shown, setShown] = useState(false);
  return (
    <div className={`relative ${className}`}>
      <textarea
        {...props}
        // Browsers can't mask a textarea as a password; this non-standard property does.
        style={shown ? undefined : ({ WebkitTextSecurity: "disc" } as CSSProperties)}
        className={`${input} w-full pr-9 font-mono`}
      />
      <RevealButton
        shown={shown}
        onToggle={() => setShown(!shown)}
        className="absolute top-1.5 right-1.5"
      />
    </div>
  );
}
