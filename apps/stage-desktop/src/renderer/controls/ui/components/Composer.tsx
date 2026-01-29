import React, { useEffect, useLayoutEffect, useMemo, useRef } from "react";

export function Composer(props: {
  value: string;
  busy: boolean;
  disabled?: boolean;
  onChange: (v: string) => void;
  onSend: (text: string) => Promise<void> | void;
}) {
  const { value, busy, disabled, onChange, onSend } = props;
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const canSend = useMemo(() => !disabled && !busy && Boolean(value.trim()), [disabled, busy, value]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.max(44, Math.min(180, el.scrollHeight))}px`;
  }, [value]);

  useEffect(() => {
    // Focus on first mount (Chat-first UX).
    inputRef.current?.focus();
  }, []);

  async function send() {
    const msg = value.trim();
    if (!msg) return;
    if (busy) return;
    await onSend(msg);
  }

  return (
    <div className="composer" aria-label="Composer">
      <div className="composerInner">
        <button className="iconBtn attachBtn" type="button" disabled aria-label="Attach (disabled)">
          +
        </button>

        <textarea
          ref={inputRef}
          className="composerInput"
          value={value}
          placeholder="Message…"
          spellCheck={false}
          disabled={Boolean(disabled)}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              (e.target as HTMLTextAreaElement).blur();
              return;
            }
            if (e.key !== "Enter") return;
            if (e.shiftKey) return; // Shift+Enter: newline
            e.preventDefault();
            void send();
          }}
        />

        <button className="btn btnPrimary" type="button" disabled={!canSend} onClick={() => void send()} aria-label="Send">
          {busy ? "…" : "Send"}
        </button>
      </div>

      <div className="composerHint">Enter 发送 · Shift+Enter 换行</div>
    </div>
  );
}

