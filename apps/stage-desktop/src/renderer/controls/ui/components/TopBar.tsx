import React, { useEffect, useRef, useState } from "react";

type Theme = "light" | "dark";

// Menu icon SVG
function MenuIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

// More icon SVG
function MoreIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </svg>
  );
}

// Sun icon SVG
function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

// Moon icon SVG
function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

export function TopBar(props: {
  title: string;
  connection: { connected: boolean; provider?: string };
  theme: Theme;
  devMode: boolean;
  onToggleDrawer: () => void;
  onToggleTheme: () => void;
  onToggleDevMode: () => void;
  onClearUiLogs: () => void;
}) {
  const {
    title,
    connection,
    theme,
    devMode,
    onToggleDrawer,
    onToggleTheme,
    onToggleDevMode,
    onClearUiLogs
  } = props;

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (menuRef.current && menuRef.current.contains(target)) return;
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <header className="topBar" role="banner">
      <div className="topBarLeft">
        <button className="iconBtn" type="button" onClick={onToggleDrawer} aria-label="打开侧边栏">
          <MenuIcon />
        </button>

        <div className="topTitle">
          <div className="topName">{title}</div>
          <div className="topSub">
            <span className={`dot ${connection.connected ? "on" : ""}`} aria-hidden="true" />
            <span>{connection.connected ? "已连接" : "离线"}</span>
            {connection.provider && <span className="pill">{connection.provider}</span>}
          </div>
        </div>
      </div>

      <div className="topRight" ref={menuRef}>
        <button
          className="iconBtn"
          type="button"
          onClick={onToggleTheme}
          aria-label={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"}
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>

        <button
          className="iconBtn"
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="更多选项"
          aria-expanded={menuOpen}
        >
          <MoreIcon />
        </button>

        {menuOpen && (
          <div className="menu" role="menu">
            <button
              className="menuItem"
              type="button"
              role="menuitem"
              onClick={() => {
                onToggleDevMode();
                setMenuOpen(false);
              }}
            >
              <span>开发者模式</span>
              <span className="menuItemValue">{devMode ? "开启" : "关闭"}</span>
            </button>
            <button
              className="menuItem"
              type="button"
              role="menuitem"
              onClick={() => {
                onClearUiLogs();
                setMenuOpen(false);
              }}
            >
              清空 UI 日志
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
