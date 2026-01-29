import { useCallback, useRef, useState } from "react";

export type ToastState = { message: string; visible: boolean };

export function useToast() {
  const [toast, setToast] = useState<ToastState>({ message: "", visible: false });
  const timerRef = useRef<number | null>(null);

  const showToast = useCallback((message: string, opts?: { timeoutMs?: number }) => {
    const ms = Math.max(500, Math.min(9000, Number(opts?.timeoutMs ?? 2200)));
    setToast({ message, visible: Boolean(message) });
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    if (message) {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setToast((t) => ({ ...t, visible: false }));
      }, ms);
    }
  }, []);

  const hideToast = useCallback(() => setToast((t) => ({ ...t, visible: false })), []);

  return { toast, showToast, hideToast };
}

