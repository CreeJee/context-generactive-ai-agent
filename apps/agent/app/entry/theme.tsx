import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

const themes = [
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

/** Runs before paint; a blocked storage API still allows the system theme. */
export const themeScript = `(() => {
  let theme = "system";
  try { theme = localStorage.getItem("context-agent-theme") || "system"; } catch {}
  document.documentElement.classList.toggle("dark",
    theme === "dark" || (theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches));
})();`;

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
      <SelectTrigger size="sm" aria-label="화면 테마">
        <SelectValue />
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
