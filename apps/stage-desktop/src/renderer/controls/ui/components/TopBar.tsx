import React, { useEffect, useRef, useState } from "react";

type Theme = "light" | "dark";

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
    <div className="topBar" role="banner">
      <button className="iconBtn" type="button" onClick={onToggleDrawer} aria-label="Toggle sidebar">
        ☰
      </button>

      <div className="topTitle">
        <div className="topName">{title}</div>
        <div className="topSub">
          <span className={`dot ${connection.connected ? "on" : "off"}`} aria-hidden="true" />
          <span>{connection.connected ? "Connected" : "Offline"}</span>
          {connection.provider ? <span className="pill"> {connection.provider}</span> : null}
        </div>
      </div>

      <div className="topRight" ref={menuRef}>
        <button
          className="iconBtn"
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Menu"
          aria-expanded={menuOpen}
        >
          ⋯
        </button>

        {menuOpen ? (
          <div className="menu" role="menu">
            <button
              className="menuItem"
              type="button"
              role="menuitem"
              onClick={() => {
                onToggleTheme();
                setMenuOpen(false);
              }}
            >
              主题：{theme === "dark" ? "深色" : "浅色"}
            </button>
            <button
              className="menuItem"
              type="button"
              role="menuitem"
              onClick={() => {
                onToggleDevMode();
                setMenuOpen(false);
              }}
            >
              Dev Mode：{devMode ? "On" : "Off"}
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
        ) : null}
      </div>
    </div>
  );
}

