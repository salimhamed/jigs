import { useEffect } from "react";
import { toast } from "sonner";

/** Shows what an action returned as a toast. */
export function useActionToast(data: { error?: string; message?: string } | undefined) {
  useEffect(() => {
    if (data?.error) toast.error(data.error);
    else if (data?.message) toast.success(data.message);
  }, [data]);
}
