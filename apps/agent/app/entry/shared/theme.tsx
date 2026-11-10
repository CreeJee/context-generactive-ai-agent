import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { isTruthy } from "../../truthy.ts";
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
  {
    value: "system",
    label: msg({
      message: "시스템 테마",
      comment: "Theme picker option: follow the OS color scheme",
    }),
  },
  {
    value: "light",
    label: msg({ message: "라이트 모드", comment: "Theme picker option: always light colors" }),
  },
  {
    value: "dark",
    label: msg({ message: "다크 모드", comment: "Theme picker option: always dark colors" }),
  },
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
  const { t } = useLingui();
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
  const label = t(current.label);
  const triggerLabel = t`화면 테마: ${label}`;
  const items = themes.map((item) => ({ value: item.value, label: t(item.label) }));
  const Icon =
    current.value === "light" ? SunIcon : current.value === "dark" ? MoonIcon : MonitorIcon;
  return (
    <Select
      value={theme}
      items={items}
      onValueChange={(value) => {
        const selected = themes.find((item) => item.value === value);
        if (!isTruthy(selected)) return;
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
        className="min-w-6 justify-center [&_[data-slot=select-value]]:flex-none"
        aria-label={triggerLabel}
        title={triggerLabel}
      >
        <SelectValue>
          <Icon aria-hidden="true" className="size-3.5" />
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
