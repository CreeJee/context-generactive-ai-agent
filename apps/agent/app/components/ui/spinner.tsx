import { useLingui } from "@lingui/react/macro";
import { cn } from "cn";
import { Loader2Icon } from "lucide-react";

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  const { t } = useLingui();
  return (
    <Loader2Icon
      data-slot="spinner"
      role="status"
      aria-label={t({
        message: "불러오는 중",
        comment: "Screen reader label of a loading spinner",
      })}
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
