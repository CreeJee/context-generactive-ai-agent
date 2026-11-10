import { Trans, useLingui } from "@lingui/react/macro";
import { Data } from "effect";
import { useEffect, useState } from "react";
import { Kbd, KbdGroup } from "~/components/ui/kbd";
import { cn } from "~/lib/utils";

/** What the input box is doing, which decides the status and the keys it offers. */
export type ComposerMode = Data.TaggedEnum<{
  idle: {};
  generating: {};
  editing: {};
  approval: {};
}>;
export const ComposerMode = Data.taggedEnum<ComposerMode>();

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
  return ComposerMode.$match(mode, {
    idle: () => null,
    generating: () => (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60" />
          <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
        </span>
        <Trans comment="Composer status while the model writes its answer">답변 중</Trans>
      </span>
    ),
    editing: () => (
      <span className="text-xs font-medium text-primary">
        <Trans>대기 메시지 편집 중</Trans>
      </span>
    ),
    approval: () => (
      <span className="text-xs text-warning">
        <Trans>승인을 기다리는 중</Trans>
      </span>
    ),
  });
}

/**
 * The keys that change meaning right now, shown on wide screens only. Plain sending needs no hint;
 * while answering and while editing, Enter does something else.
 */
export function ComposerShortcuts({ mode, className }: { mode: ComposerMode; className?: string }) {
  const { t } = useLingui();
  const modifier = useModifierKey();
  const shortcuts = ComposerMode.$match(mode, {
    idle: () => [],
    approval: () => [],
    generating: () => [
      {
        keys: ["⏎"],
        label: t({ message: "대기열", comment: "Shortcut hint: Enter queues the message" }),
      },
      {
        keys: [modifier, "⇧", "⏎"],
        label: t({ message: "끼어들기", comment: "Shortcut hint: the keys interrupt the answer" }),
      },
    ],
    editing: () => [
      {
        keys: ["⏎"],
        label: t({ message: "저장", comment: "Shortcut hint: Enter saves the edited message" }),
      },
      {
        keys: ["Esc"],
        label: t({ message: "지우기", comment: "Shortcut hint: Esc clears the edit" }),
      },
    ],
  });
  if (shortcuts.length === 0) return null;
  return (
    <span
      className={cn("hidden items-center gap-3 text-2xs text-muted-foreground md:flex", className)}
    >
      {shortcuts.map((shortcut) => (
        <Shortcut key={shortcut.keys.join(" ")} keys={shortcut.keys} label={shortcut.label} />
      ))}
    </span>
  );
}
