import React, { useRef, useState, useEffect } from "react";

export type SidebarTab = "llm" | "actions" | "memory" | "theme" | "console";

export function SidebarDrawer(props: {
  open: boolean;
  tab: SidebarTab;
  devMode: boolean;
  onClose: () => void;
  onTabChange: (t: SidebarTab) => void;
  children: React.ReactNode;
}) {
  const { open, tab, devMode, onClose, onTabChange, children } = props;
  const [animating, setAnimating] = useState(false);
  const prevTabRef = useRef<SidebarTab>(tab);
  const contentRef = useRef<HTMLDivElement>(null);

  // Animate tab content on change
  useEffect(() => {
    if (prevTabRef.current !== tab) {
      setAnimating(true);
      const timer = setTimeout(() => setAnimating(false), 200);
      prevTabRef.current = tab;
      return () => clearTimeout(timer);
    }
  }, [tab]);

  const tabs: { id: SidebarTab; label: string; icon: string; hidden?: boolean }[] = [
    { id: "llm", label: "LLM", icon: "⚙" },
    { id: "actions", label: "Actions", icon: "🎭" },
    { id: "memory", label: "Memory", icon: "🧠" },
    { id: "theme", label: "Theme", icon: "🎨" },
    { id: "console", label: "Console", icon: "🪵", hidden: !devMode }
  ];

  return (
    <div className={`drawerOverlay ${open ? "isOpen" : ""}`} aria-hidden={!open}>
      <button className="drawerBackdrop" type="button" aria-label="Close sidebar" onClick={onClose} />

      <aside className="drawer" aria-label="Sidebar">
        <div className="drawerHeader">
          <div className="drawerTitle">Control Center</div>
          <button className="iconBtn" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="drawerTabs" role="tablist" aria-label="Sidebar tabs">
          {tabs
            .filter((t) => !t.hidden)
            .map((t) => (
              <button
                key={t.id}
                className={`tabBtn ${tab === t.id ? "isActive" : ""}`}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => onTabChange(t.id)}
              >
                <span className="tabIcon" aria-hidden="true">
                  {t.icon}
                </span>
                <span className="tabLabel">{t.label}</span>
              </button>
            ))}
        </div>

        <div className={`drawerBody ${animating ? "tabAnimating" : ""}`} ref={contentRef}>{children}</div>
      </aside>
    </div>
  );
}

