import React, { useEffect } from "react";

type ShortcutItem = {
  keys: string[];
  description: string;
};

const SHORTCUTS: ShortcutItem[] = [
  { keys: ["Ctrl", "F"], description: "搜索消息" },
  { keys: ["Enter"], description: "发送消息" },
  { keys: ["Shift", "Enter"], description: "换行" },
  { keys: ["Escape"], description: "关闭搜索 / 取消输入" },
  { keys: ["Ctrl", "K"], description: "打开快捷键帮助" }
];

export function KeyboardShortcuts(props: { isOpen: boolean; onClose: () => void }) {
  const { isOpen, onClose } = props;

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="modalOverlay" onClick={onClose}>
      <div className="modalContent shortcutsModal" onClick={(e) => e.stopPropagation()}>
        <div className="modalHeader">
          <h3>键盘快捷键</h3>
          <button className="modalClose" type="button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="shortcutsList">
          {SHORTCUTS.map((shortcut, index) => (
            <div key={index} className="shortcutItem">
              <div className="shortcutKeys">
                {shortcut.keys.map((key, i) => (
                  <span key={i}>
                    <kbd className="shortcutKey">{key}</kbd>
                    {i < shortcut.keys.length - 1 && <span className="shortcutPlus">+</span>}
                  </span>
                ))}
              </div>
              <div className="shortcutDesc">{shortcut.description}</div>
            </div>
          ))}
        </div>
        <div className="modalFooter">
          <button className="btn btnSm" type="button" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
