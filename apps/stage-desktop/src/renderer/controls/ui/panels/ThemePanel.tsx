import React, { useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";
export type AccentColor = "green" | "blue" | "purple" | "orange" | "pink" | "red";
export type BackgroundType = "default" | "solid" | "gradient" | "image";

type ThemePreset = {
  id: AccentColor;
  name: string;
  light: string;
  dark: string;
};

type BackgroundPreset = {
  id: string;
  name: string;
  type: "solid" | "gradient";
  value: string;
  darkValue?: string;
};

const ACCENT_PRESETS: ThemePreset[] = [
  { id: "green", name: "绿色", light: "#10a37f", dark: "#19c37d" },
  { id: "blue", name: "蓝色", light: "#3b82f6", dark: "#60a5fa" },
  { id: "purple", name: "紫色", light: "#8b5cf6", dark: "#a78bfa" },
  { id: "orange", name: "橙色", light: "#f59e0b", dark: "#fbbf24" },
  { id: "pink", name: "粉色", light: "#ec4899", dark: "#f472b6" },
  { id: "red", name: "红色", light: "#ef4444", dark: "#f87171" }
];

const BACKGROUND_PRESETS: BackgroundPreset[] = [
  { id: "default", name: "默认", type: "solid", value: "#ededed", darkValue: "#111111" },
  { id: "warm", name: "温暖", type: "solid", value: "#fef3c7", darkValue: "#1c1917" },
  { id: "cool", name: "冷色", type: "solid", value: "#e0f2fe", darkValue: "#0c1929" },
  { id: "mint", name: "薄荷", type: "solid", value: "#d1fae5", darkValue: "#0d1f17" },
  { id: "lavender", name: "薰衣草", type: "solid", value: "#ede9fe", darkValue: "#1e1b2e" },
  { id: "sunset", name: "日落", type: "gradient", value: "linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)", darkValue: "linear-gradient(135deg, #1f1c2c 0%, #3a1c71 100%)" },
  { id: "ocean", name: "海洋", type: "gradient", value: "linear-gradient(135deg, #a1c4fd 0%, #c2e9fb 100%)", darkValue: "linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)" },
  { id: "forest", name: "森林", type: "gradient", value: "linear-gradient(135deg, #d4fc79 0%, #96e6a1 100%)", darkValue: "linear-gradient(135deg, #0f2014 0%, #162c1a 100%)" }
];

const LS_ACCENT = "sama.ui.accent.v1";
const LS_FONT_SIZE = "sama.ui.fontSize.v1";
const LS_THEME_MODE = "sama.ui.themeMode.v1";
const LS_BACKGROUND = "sama.ui.background.v1";
const LS_CUSTOM_BG_IMAGE = "sama.ui.customBgImage.v1";

export function loadAccent(): AccentColor {
  try {
    const v = localStorage.getItem(LS_ACCENT);
    if (v && ACCENT_PRESETS.some((p) => p.id === v)) return v as AccentColor;
  } catch {}
  return "green";
}

export function loadFontSize(): number {
  try {
    const v = parseInt(localStorage.getItem(LS_FONT_SIZE) || "", 10);
    if (v >= 12 && v <= 20) return v;
  } catch {}
  return 15;
}

export function loadThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(LS_THEME_MODE);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {}
  return "light";
}

export function loadBackground(): string {
  try {
    return localStorage.getItem(LS_BACKGROUND) || "default";
  } catch {}
  return "default";
}

export function loadCustomBgImage(): string | null {
  try {
    return localStorage.getItem(LS_CUSTOM_BG_IMAGE);
  } catch {}
  return null;
}

export function applyBackground(bgId: string, isDark: boolean, customImage?: string | null) {
  const root = document.documentElement;

  if (bgId === "custom" && customImage) {
    root.style.setProperty("--chat-bg", `url("${customImage}")`);
    root.style.setProperty("--chat-bg-image", `url("${customImage}")`);
    // Add overlay for readability
    const overlayColor = isDark ? "rgba(0, 0, 0, 0.6)" : "rgba(255, 255, 255, 0.7)";
    document.querySelectorAll(".timeline, .chatShell").forEach((el) => {
      (el as HTMLElement).style.background = `linear-gradient(${overlayColor}, ${overlayColor}), url("${customImage}") center/cover`;
    });
    return;
  }

  // Reset custom image styles
  document.querySelectorAll(".timeline, .chatShell").forEach((el) => {
    (el as HTMLElement).style.background = "";
  });

  const preset = BACKGROUND_PRESETS.find((p) => p.id === bgId);
  if (!preset) return;

  const value = isDark && preset.darkValue ? preset.darkValue : preset.value;
  root.style.setProperty("--chat-bg", value);
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
  const [background, setBackground] = useState<string>(loadBackground);
  const [customBgImage, setCustomBgImage] = useState<string | null>(loadCustomBgImage);

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

  // Apply background on mount and when changed
  useEffect(() => {
    applyBackground(background, theme === "dark", customBgImage);
    try {
      localStorage.setItem(LS_BACKGROUND, background);
    } catch {}
  }, [background, theme, customBgImage]);

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
    setBackground("default");
    setCustomBgImage(null);
    try {
      localStorage.removeItem(LS_CUSTOM_BG_IMAGE);
    } catch {}
    onToast("已恢复默认主题");
  };

  const handleCustomImage = async () => {
    // Create a file input to select image
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      // Convert to base64 data URL
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        try {
          localStorage.setItem(LS_CUSTOM_BG_IMAGE, dataUrl);
          setCustomBgImage(dataUrl);
          setBackground("custom");
          onToast("背景图片已设置");
        } catch (err) {
          onToast("图片太大，无法保存");
        }
      };
      reader.readAsDataURL(file);
    };
    input.click();
  };

  const handleClearCustomImage = () => {
    try {
      localStorage.removeItem(LS_CUSTOM_BG_IMAGE);
    } catch {}
    setCustomBgImage(null);
    setBackground("default");
    onToast("已清除自定义背景");
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

      {/* Chat Background */}
      <div className="card">
        <div className="field">
          <label className="label">聊天背景</label>
          <div className="bgGrid">
            {BACKGROUND_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={`bgBtn ${background === preset.id ? "isActive" : ""}`}
                style={{
                  "--bg-preview": theme === "dark" && preset.darkValue ? preset.darkValue : preset.value
                } as React.CSSProperties}
                onClick={() => setBackground(preset.id)}
                title={preset.name}
              >
                <span className="bgSwatch" />
                <span className="bgName">{preset.name}</span>
              </button>
            ))}
            <button
              type="button"
              className={`bgBtn ${background === "custom" ? "isActive" : ""}`}
              onClick={handleCustomImage}
              title="自定义图片"
            >
              <span className="bgSwatch bgCustom">
                {customBgImage ? (
                  <img src={customBgImage} alt="" className="bgCustomImg" />
                ) : (
                  <span className="bgAddIcon">+</span>
                )}
              </span>
              <span className="bgName">自定义</span>
            </button>
          </div>
          {background === "custom" && customBgImage && (
            <button
              type="button"
              className="btn btnSm btnDanger"
              style={{ marginTop: 8 }}
              onClick={handleClearCustomImage}
            >
              清除自定义背景
            </button>
          )}
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
