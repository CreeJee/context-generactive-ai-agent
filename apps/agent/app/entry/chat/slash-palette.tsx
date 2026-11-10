import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { SparklesIcon, TerminalSquareIcon } from "lucide-react";
import { CommandGroup, CommandItem, CommandList } from "~/components/ui/command";
import type { Suggestion } from "./slash-commands";

const headings = {
  command: msg({ message: "명령", comment: "Heading of the slash command group in the palette" }),
  skill: msg({ message: "Skills", comment: "Heading of the skill group in the slash palette" }),
  value: msg({
    message: "고를 수 있는 값",
    comment: "Heading of the values the typed slash command can take",
  }),
} satisfies Record<Suggestion["kind"], MessageDescriptor>;

// The order suggestions come in, so ↑/↓ walk the groups top to bottom.
const groups: ReadonlyArray<Suggestion["kind"]> = ["command", "skill", "value"];

/**
 * Suggestions for a slash command above the composer. Focus stays in the composer: it moves the
 * highlight with ↑/↓ and completes with Tab or Enter, so the list only shows and takes clicks.
 */
export function SlashPalette({
  suggestions,
  onPick,
}: {
  suggestions: readonly Suggestion[];
  onPick: (suggestion: Suggestion) => void;
}) {
  const { t } = useLingui();
  return (
    // The palette floats over the conversation, so its frame lifts it the way a popover would.
    <div className="mb-2 overflow-hidden rounded-xl border bg-popover shadow-md">
      <CommandList>
        {groups.map((kind) => {
          const items = suggestions.filter((suggestion) => suggestion.kind === kind);
          if (items.length === 0) return null;
          return (
            <CommandGroup key={kind} heading={t(headings[kind])}>
              {items.map((suggestion) => (
                <CommandItem
                  key={suggestion.text}
                  value={suggestion.text}
                  // Keep the caret in the composer while clicking.
                  onMouseDown={(event) => event.preventDefault()}
                  onSelect={() => onPick(suggestion)}
                >
                  {suggestion.kind === "skill" ? <SparklesIcon /> : <TerminalSquareIcon />}
                  {/* Two columns: names line up and never wrap, descriptions take the rest. */}
                  <span
                    title={suggestion.label}
                    className="w-36 shrink-0 truncate font-mono sm:w-52"
                  >
                    {suggestion.label}
                  </span>
                  <span
                    title={suggestion.description}
                    className="min-w-0 flex-1 truncate text-muted-foreground"
                  >
                    {suggestion.description}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          );
        })}
      </CommandList>
      <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">
        <Trans comment="Keyboard hint under the slash palette">
          ↑↓ 고르기, Tab 채우기, Enter 실행
        </Trans>
      </p>
    </div>
  );
}
