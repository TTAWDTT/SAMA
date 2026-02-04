import React, { useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";
export type AccentColor = "green" | "blue" | "purple" | "orange" | "pink" | "red";

type ThemePreset = {
  id: AccentColor;
  name: string;
  light: string;
  dark: string;
};

const ACCENT_PRESETS: ThemePreset[] = [
  { id: "orange", name: "橙色", light: "#d97757", dark: "#e8956a" },
  { id: "blue", name: "蓝色", light: "#6a9bcc", dark: "#8bb4d9" },
  { id: "green", name: "绿色", light: "#788c5d", dark: "#9aad7e" },
  { id: "purple", name: "紫色", light: "#8b5cf6", dark: "#a78bfa" },
  { id: "pink", name: "粉色", light: "#ec4899", dark: "#f472b6" },
  { id: "red", name: "红色", light: "#ef4444", dark: "#f87171" }
];

const LS_ACCENT = "sama.ui.accent.v1";
const LS_FONT_SIZE = "sama.ui.fontSize.v1";
const LS_THEME_MODE = "sama.ui.themeMode.v1";

export function loadAccent(): AccentColor {
  try {
    const v = localStorage.getItem(LS_ACCENT);
    if (v && ACCENT_PRESETS.some((p) => p.id === v)) return v as AccentColor;
  } catch {}
  return "orange";
}

export function loadFontSize(): number {
  try {
    const v = parseInt(localStorage.getItem(LS_FONT_SIZE) || "", 10);
    if (v >= 12 && v <= 20) return v;
  } catch {}
  return 15;
}

function loadThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(LS_THEME_MODE);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {}
  return "light";
}

export function applyAccentColor(accent: AccentColor, isDark: boolean) {
  const preset = ACCENT_PRESETS.find((p) => p.id === accent);
  if (!preset) return;

  const color = isDark ? preset.dark : preset.light;
  document.documentElement.style.setProperty("--accent", color);
  document.documentElement.style.setProperty(
    "--accent-hover",
    adjustBrightness(color, isDark ? 0.1 : -0.1)
  );
  document.documentElement.style.setProperty(
    "--accent-light",
    `${color}${isDark ? "26" : "1a"}`
  );
}

export function applyFontSize(size: number) {
  document.documentElement.style.setProperty("font-size", `${size}px`);
}

function adjustBrightness(hex: string, percent: number): string {
  const num = parseInt(hex.slice(1), 16);
  const r = Math.round(Math.min(255, Math.max(0, ((num >> 16) & 0xff) + 255 * percent)));
  const g = Math.round(Math.min(255, Math.max(0, ((num >> 8) & 0xff) + 255 * percent)));
  const b = Math.round(Math.min(255, Math.max(0, (num & 0xff) + 255 * percent)));
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

type ThemePanelProps = {
  theme: "light" | "dark";
  onThemeChange: (mode: ThemeMode) => void;
  onToast: (msg: string) => void;
};

export function ThemePanel(props: ThemePanelProps) {
  const { theme, onThemeChange, onToast } = props;

  const [accent, setAccent] = useState<AccentColor>(loadAccent);
  const [fontSize, setFontSize] = useState<number>(loadFontSize);
  const [themeMode, setThemeMode] = useState<ThemeMode>(loadThemeMode);

  // Apply accent on mount and when changed
  useEffect(() => {
    applyAccentColor(accent, theme === "dark");
    try {
      localStorage.setItem(LS_ACCENT, accent);
    } catch {}
  }, [accent, theme]);

  // Apply font size on mount and when changed
  useEffect(() => {
    applyFontSize(fontSize);
    try {
      localStorage.setItem(LS_FONT_SIZE, String(fontSize));
    } catch {}
  }, [fontSize]);

  // Handle theme mode
  useEffect(() => {
    try {
      localStorage.setItem(LS_THEME_MODE, themeMode);
    } catch {}
    if (themeMode === "system") {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      onThemeChange(prefersDark ? "dark" : "light");
    } else {
      onThemeChange(themeMode);
    }
  }, [themeMode, onThemeChange]);

  // Listen for system theme changes when in system mode
  useEffect(() => {
    if (themeMode !== "system") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      onThemeChange(e.matches ? "dark" : "light");
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [themeMode, onThemeChange]);

  const handleReset = () => {
    setAccent("green");
    setFontSize(15);
    setThemeMode("light");
    onToast("已恢复默认主题");
  };

  return (
    <div className="themePanel">
      <div className="panelHeader">
        <div className="panelTitle">主题设置</div>
        <div className="panelSub">自定义外观和配色</div>
      </div>

      {/* Theme Mode */}
      <div className="card">
        <div className="field">
          <label className="label">主题模式</label>
          <div className="seg">
            <button
              type="button"
              className={`segBtn ${themeMode === "light" ? "isActive" : ""}`}
              onClick={() => setThemeMode("light")}
            >
              ☀️ 浅色
            </button>
            <button
              type="button"
              className={`segBtn ${themeMode === "dark" ? "isActive" : ""}`}
              onClick={() => setThemeMode("dark")}
            >
              🌙 深色
            </button>
            <button
              type="button"
              className={`segBtn ${themeMode === "system" ? "isActive" : ""}`}
              onClick={() => setThemeMode("system")}
            >
              💻 跟随系统
            </button>
          </div>
        </div>
      </div>

      {/* Accent Color */}
      <div className="card">
        <div className="field">
          <label className="label">主题色</label>
          <div className="accentGrid">
            {ACCENT_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={`accentBtn ${accent === preset.id ? "isActive" : ""}`}
                style={{
                  "--preset-color": theme === "dark" ? preset.dark : preset.light
                } as React.CSSProperties}
                onClick={() => setAccent(preset.id)}
                title={preset.name}
              >
                <span className="accentSwatch" />
                <span className="accentName">{preset.name}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Font Size */}
      <div className="card">
        <div className="field">
          <label className="label">字体大小</label>
          <div className="fontSizeRow">
            <span className="fontSizeLabel">A</span>
            <input
              type="range"
              className="range"
              min={12}
              max={20}
              step={1}
              value={fontSize}
              onChange={(e) => setFontSize(Number(e.target.value))}
            />
            <span className="fontSizeLabelLg">A</span>
            <span className="fontSizeValue">{fontSize}px</span>
          </div>
          <div className="help">调整界面整体字体大小</div>
        </div>
      </div>

      {/* Reset */}
      <div className="card">
        <button type="button" className="btn btnSm" onClick={handleReset}>
          恢复默认设置
        </button>
      </div>
    </div>
  );
}
