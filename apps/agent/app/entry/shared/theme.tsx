import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { isTruthy } from "../../truthy.ts";
import { useEffect, useState } from "react";
import { Field, FieldContent, FieldDescription, FieldLabel } from "~/components/ui/field";
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

/** Puts the theme on the page: dark when chosen, or when the system is dark and it is followed. */
function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle(
    "dark",
    theme === "dark" ||
      (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches),
  );
}

/** Keeps the page on the saved theme, also when the system's own theme changes. */
export function ThemeSync() {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => applyTheme(savedTheme());
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);
  return null;
}

/** One settings line: the theme to show, saved in this browser and applied at once. */
export function ThemeField() {
  const { t } = useLingui();
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => {
    setTheme(savedTheme());
  }, []);

  const items = themes.map((item) => ({ value: item.value, label: t(item.label) }));
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor="app-theme">
          <Trans comment="Field label: the app's color theme">화면 테마</Trans>
        </FieldLabel>
        <FieldDescription>
          <Trans comment="Description of the theme field">이 브라우저에 저장됩니다.</Trans>
        </FieldDescription>
      </FieldContent>
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
          applyTheme(selected.value);
        }}
      >
        <SelectTrigger id="app-theme" className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
