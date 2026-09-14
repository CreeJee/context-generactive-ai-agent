import { useEffect, useState } from "react";
import { Kbd, KbdGroup } from "~/components/ui/kbd";
import { cn } from "~/lib/utils";

/** What the input box is doing, which decides the status and the keys it offers. */
export type ComposerMode =
  | { readonly kind: "idle" }
  | { readonly kind: "generating" }
  | { readonly kind: "editing" }
  | { readonly kind: "approval" };

/** macOS shows ⌘ for the steer shortcut; elsewhere Ctrl. Decided after hydration. */
function useModifierKey() {
  const [key, setKey] = useState("Ctrl");
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.userAgent)) setKey("⌘");
  }, []);
  return key;
}

function Shortcut({ keys, label }: { keys: readonly string[]; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <KbdGroup>
        {keys.map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
      </KbdGroup>
      {label}
    </span>
  );
}

/** The left side of the composer toolbar: a short state line with a live dot while answering. */
export function ComposerStatus({ mode }: { mode: ComposerMode }) {
  switch (mode.kind) {
    case "idle":
      return null;
    case "generating":
      return (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60" />
            <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
          </span>
          답변 중
        </span>
      );
    case "editing":
      return <span className="text-xs font-medium text-primary">대기 메시지 편집 중</span>;
    case "approval":
      return <span className="text-xs text-amber-600 dark:text-amber-400">승인을 기다리는 중</span>;
  }
}

/**
 * The keys that change meaning right now, shown on wide screens only. Plain sending needs no hint;
 * while answering and while editing, Enter does something else.
 */
export function ComposerShortcuts({ mode, className }: { mode: ComposerMode; className?: string }) {
  const modifier = useModifierKey();
  const shortcuts = (() => {
    switch (mode.kind) {
      case "idle":
      case "approval":
        return [];
      case "generating":
        return [
          { keys: ["⏎"], label: "대기열" },
          { keys: [modifier, "⇧", "⏎"], label: "바로 전달" },
        ];
      case "editing":
        return [
          { keys: ["⏎"], label: "저장" },
          { keys: ["Esc"], label: "지우기" },
        ];
    }
  })();
  if (shortcuts.length === 0) return null;
  return (
    <span
      className={cn(
        "hidden items-center gap-3 text-[0.6875rem] text-muted-foreground md:flex",
        className,
      )}
    >
      {shortcuts.map((shortcut) => (
        <Shortcut key={shortcut.label} keys={shortcut.keys} label={shortcut.label} />
      ))}
    </span>
  );
}
