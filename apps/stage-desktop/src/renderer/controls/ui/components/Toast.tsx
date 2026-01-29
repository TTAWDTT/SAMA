import React from "react";
import type { ToastItem } from "../hooks/useToast";

// Single toast (legacy)
export function Toast(props: { message: string; visible: boolean; onDismiss?: () => void }) {
  const { message, visible, onDismiss } = props;
  return (
    <div className="toastHost" aria-live="polite" aria-atomic="true">
      <div className={`toast ${visible ? "isShow" : ""}`} role="status">
        <div className="toastMsg">{message}</div>
        {onDismiss ? (
          <button className="toastX" type="button" onClick={onDismiss} aria-label="Dismiss">
            ×
          </button>
        ) : null}
      </div>
    </div>
  );
}

// Multi-toast host
export function ToastHost(props: { toasts: ToastItem[]; onDismiss: (id: string) => void }) {
  const { toasts, onDismiss } = props;
  return (
    <div className="toastHost" aria-live="polite" aria-atomic="true">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.type} ${t.visible ? "isShow" : ""}`}
          role="status"
        >
          <span className="toastIcon" aria-hidden="true">
            {t.type === "success" ? "✓" : t.type === "error" ? "✕" : t.type === "warning" ? "!" : "ℹ"}
          </span>
          <div className="toastMsg">{t.message}</div>
          <button className="toastX" type="button" onClick={() => onDismiss(t.id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
