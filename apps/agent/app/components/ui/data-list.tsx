import type { ComponentProps, ReactNode } from "react";
import { cn } from "~/lib/utils";

export function DataList({ className, ...props }: ComponentProps<"dl">) {
  return (
    <dl
      className={cn("grid grid-cols-[6rem_minmax(0,1fr)] gap-x-2 gap-y-2", className)}
      {...props}
    />
  );
}

export function DataListItem({
  term,
  children,
  className,
  ...props
}: ComponentProps<"div"> & { term: ReactNode }) {
  return (
    <div className={cn("col-span-2 grid grid-cols-subgrid gap-x-2", className)} {...props}>
      <dt className="pt-2 text-xs text-muted-foreground">{term}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}
