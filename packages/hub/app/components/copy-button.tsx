import { Copy } from "lucide-react";
import { toast } from "sonner";
import { secondaryButton } from "./ui.ts";

export function CopyButton({ text, label }: { text: string; label: string }) {
  return (
    <button
      type="button"
      aria-label={`Copy ${label.toLowerCase()}`}
      className={`${secondaryButton} shrink-0`}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        toast.success(`${label} copied`);
      }}
    >
      <Copy className="size-4" />
      Copy
    </button>
  );
}
