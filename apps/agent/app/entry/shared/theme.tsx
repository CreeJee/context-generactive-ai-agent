import { useEffect, useState } from "react";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

export const themes = [
  { value: "system", label: "시스템 테마" },
  { value: "light", label: "라이트 모드" },
  { value: "dark", label: "다크 모드" },
] as const;
type Theme = (typeof themes)[number]["value"];
const storageKey = "context-agent-theme";

function savedTheme(): Theme {
  try {
    const saved = localStorage.getItem(storageKey);
    return themes.find((theme) => theme.value === saved)?.value ?? "system";
  } catch {
    return "system";
  }
}

export function ThemeSelect() {
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => {
    setTheme(savedTheme());
  }, []);
  useEffect(() => {
    if (theme === null) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      document.documentElement.classList.toggle(
        "dark",
        theme === "dark" || (theme === "system" && media.matches),
      );
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  const current = themes.find((item) => item.value === theme) ?? themes[0];
  const Icon =
    current.value === "light" ? SunIcon : current.value === "dark" ? MoonIcon : MonitorIcon;
  return (
    <Select
      value={theme}
      items={themes}
      onValueChange={(value) => {
        const selected = themes.find((item) => item.value === value);
        if (!selected) return;
        setTheme(selected.value);
        try {
          localStorage.setItem(storageKey, selected.value);
        } catch {
          /* Theme still works without storage. */
        }
      }}
    >
      <SelectTrigger
        size="sm"
        variant="ghost"
        className="h-8 min-w-9 justify-center [&_[data-slot=select-value]]:flex-none"
        aria-label={`화면 테마: ${current.label}`}
        title={`화면 테마: ${current.label}`}
      >
        <SelectValue>
          <Icon aria-hidden="true" className="size-4" />
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {themes.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
