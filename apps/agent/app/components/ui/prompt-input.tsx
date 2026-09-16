import * as React from "react";
import { cn } from "cn";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "~/components/ui/input-group";

function PromptInput({
  className,
  editing = false,
  ...props
}: React.ComponentProps<typeof InputGroup> & { editing?: boolean }) {
  return (
    <InputGroup
      className={cn(
        "h-auto flex-col rounded-xl bg-card shadow-xs dark:bg-card",
        editing && "border-primary/60 ring-2 ring-primary/15",
        className,
      )}
      {...props}
    />
  );
}

function PromptInputHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="prompt-input-header" className={cn("w-full px-3 pt-3", className)} {...props} />
  );
}

function PromptInputTextarea({
  className,
  ...props
}: React.ComponentProps<typeof InputGroupTextarea>) {
  return (
    <InputGroupTextarea
      className={cn("max-h-48 min-h-11 px-3.5 pt-3 pb-1 text-sm", className)}
      {...props}
    />
  );
}

function PromptInputFooter({
  className,
  ...props
}: Omit<React.ComponentProps<typeof InputGroupAddon>, "align">) {
  return <InputGroupAddon align="block-end" className={cn("gap-2", className)} {...props} />;
}

function PromptInputButton({
  className,
  ...props
}: Omit<React.ComponentProps<typeof InputGroupButton>, "size">) {
  return <InputGroupButton size="icon-sm" className={cn("rounded-full", className)} {...props} />;
}

export {
  PromptInput,
  PromptInputHeader,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputButton,
};
