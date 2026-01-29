import React, { useEffect } from "react";

export function Modal(props: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
  onClose: () => void;
}) {
  const { open, title, children, actions, onClose } = props;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modalOverlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modalCard">
        <div className="modalHeader">
          <div className="modalTitle">{title}</div>
          <button className="iconBtn modalClose" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modalBody">{children}</div>
        {actions ? <div className="modalActions">{actions}</div> : null}
      </div>

      <button className="modalBackdrop" type="button" aria-label="Backdrop" onClick={onClose} />
    </div>
  );
}

