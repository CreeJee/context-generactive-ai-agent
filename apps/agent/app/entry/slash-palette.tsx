import { SparklesIcon, TerminalSquareIcon } from "lucide-react";
import { Command, CommandGroup, CommandItem, CommandList } from "~/components/ui/command";
import type { Suggestion } from "./slash-commands";

const headings = {
  command: "명령",
  skill: "Skills",
  value: "고를 수 있는 값",
} satisfies Record<Suggestion["kind"], string>;

// The order suggestions come in, so ↑/↓ walk the groups top to bottom.
const groups: ReadonlyArray<Suggestion["kind"]> = ["command", "skill", "value"];

/**
 * Suggestions for a slash command above the composer. Focus stays in the composer: it moves the
 * highlight with ↑/↓ and completes with Tab or Enter, so the list only shows and takes clicks.
 */
export function SlashPalette({
  suggestions,
  highlighted,
  onPick,
}: {
  suggestions: readonly Suggestion[];
  highlighted: Suggestion;
  onPick: (suggestion: Suggestion) => void;
}) {
  return (
    // The palette floats over the conversation, so its frame lifts it the way a popover would.
    <div className="mb-2 overflow-hidden rounded-xl border bg-popover shadow-md">
      <Command shouldFilter={false} value={highlighted.text} className="h-auto">
        <CommandList>
          {groups.map((kind) => {
            const items = suggestions.filter((suggestion) => suggestion.kind === kind);
            if (items.length === 0) return null;
            return (
              <CommandGroup key={kind} heading={headings[kind]}>
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
          ↑↓로 고르고, Tab으로 채우고, Enter로 실행해요.
        </p>
      </Command>
    </div>
  );
}
