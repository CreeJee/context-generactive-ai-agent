import { TerminalSquareIcon } from "lucide-react";
import { Command, CommandGroup, CommandItem, CommandList } from "~/components/ui/command";
import type { Suggestion } from "./slash-commands";

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
          <CommandGroup heading="명령: ↑↓로 고르고, Tab으로 채우고, Enter로 실행해요">
            {suggestions.map((suggestion) => (
              <CommandItem
                key={suggestion.text}
                value={suggestion.text}
                // Keep the caret in the composer while clicking.
                onMouseDown={(event) => event.preventDefault()}
                onSelect={() => onPick(suggestion)}
              >
                <TerminalSquareIcon />
                <span className="font-mono">{suggestion.label}</span>
                <span className="truncate text-muted-foreground">{suggestion.description}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  );
}
