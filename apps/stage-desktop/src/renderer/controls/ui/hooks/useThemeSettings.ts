import { useEffect, useState } from "react";
import {
  loadAccent,
  loadFontSize,
  loadBackground,
  loadCustomBgImage,
  applyAccentColor,
  applyFontSize,
  applyBackground
} from "../panels/ThemePanel";

export type Theme = "light" | "dark";

const LS_THEME = "sama.ui.theme.v1";

function loadTheme(): Theme {
  try {
    const v = String(localStorage.getItem(LS_THEME) ?? "");
    if (v === "dark" || v === "light") return v;
  } catch {}
  return "light";
}

export type UseThemeSettingsResult = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
};

/**
 * Custom hook for theme management with persistence and accent color application.
 */
export function useThemeSettings(): UseThemeSettingsResult {
  const [theme, setThemeState] = useState<Theme>(loadTheme);

  // Initialize theme settings on mount
  useEffect(() => {
    const accent = loadAccent();
    const fontSize = loadFontSize();
    const background = loadBackground();
    const customBgImage = loadCustomBgImage();
    applyAccentColor(accent, theme === "dark");
    applyFontSize(fontSize);
    applyBackground(background, theme === "dark", customBgImage);
  }, []);

  // Re-apply accent and background when theme changes
  useEffect(() => {
    const accent = loadAccent();
    const background = loadBackground();
    const customBgImage = loadCustomBgImage();
    applyAccentColor(accent, theme === "dark");
    applyBackground(background, theme === "dark", customBgImage);
  }, [theme]);

  // Persist theme
  useEffect(() => {
    try {
      localStorage.setItem(LS_THEME, theme);
    } catch {}
  }, [theme]);

  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme);
  };

  const toggleTheme = () => {
    setThemeState((t) => (t === "dark" ? "light" : "dark"));
  };

  return {
    theme,
    setTheme,
    toggleTheme
  };
}
