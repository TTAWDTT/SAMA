import { useCallback, useRef, useState } from "react";

export type ToastType = "info" | "success" | "error" | "warning";

export type ToastItem = {
  id: string;
  message: string;
  type: ToastType;
  visible: boolean;
};

export type ToastState = { message: string; visible: boolean };

let toastIdCounter = 0;
function genToastId() {
  return `toast_${Date.now().toString(36)}_${++toastIdCounter}`;
}

export function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<string, number>>(new Map());

  // Legacy single toast state for backward compatibility
  const [toast, setToast] = useState<ToastState>({ message: "", visible: false });
  const timerRef = useRef<number | null>(null);

  const showToast = useCallback((message: string, opts?: { timeoutMs?: number; type?: ToastType }) => {
    const ms = Math.max(500, Math.min(9000, Number(opts?.timeoutMs ?? 2200)));
    const type = opts?.type ?? "info";
    const id = genToastId();

    // Legacy single toast support
    setToast({ message, visible: Boolean(message) });
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    if (message) {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setToast((t) => ({ ...t, visible: false }));
      }, ms);
    }

    // Multi-toast support
    setToasts((prev) => {
      // Limit to 5 toasts max
      const next = [...prev, { id, message, type, visible: true }];
      return next.slice(-5);
    });

    // Schedule hide
    const timerId = window.setTimeout(() => {
      setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, visible: false } : t)));
      // Remove after animation
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
        timersRef.current.delete(id);
      }, 250);
    }, ms);
    timersRef.current.set(id, timerId);

    return id;
  }, []);

  const hideToast = useCallback((id?: string) => {
    if (id) {
      const timer = timersRef.current.get(id);
      if (timer) window.clearTimeout(timer);
      setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, visible: false } : t)));
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 250);
    } else {
      // Legacy: hide single toast
      setToast((t) => ({ ...t, visible: false }));
    }
  }, []);

  return { toast, toasts, showToast, hideToast };
}
