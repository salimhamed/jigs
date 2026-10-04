import { Copy } from "lucide-react";
import { toast } from "sonner";
import { quietButton } from "./ui.ts";

export function CopyButton({ text, label }: { text: string; label: string }) {
  return (
    <button
      type="button"
      className={quietButton}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        toast.success(`${label} copied`);
      }}
    >
      <Copy className="size-4" />
      Copy {label.toLowerCase()}
    </button>
  );
}
