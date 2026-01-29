import React from "react";

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

