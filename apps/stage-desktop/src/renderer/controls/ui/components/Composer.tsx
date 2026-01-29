import React, { useEffect, useLayoutEffect, useMemo, useRef } from "react";

// Send icon SVG
function SendIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

// Loading spinner
function LoadingSpinner() {
  return (
    <div className="loadingSpinner">
      <div className="spinnerRing" />
    </div>
  );
}

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
    el.style.height = `${Math.max(52, Math.min(200, el.scrollHeight))}px`;
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
    <div className="composerArea">
      <div className="composerContainer">
        <div className="composerBox">
          <textarea
            ref={inputRef}
            className="composerTextarea"
            value={value}
            placeholder="给 SAMA 发送消息..."
            spellCheck={false}
            disabled={Boolean(disabled)}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                (e.target as HTMLTextAreaElement).blur();
                return;
              }
              if (e.key !== "Enter") return;
              // Shift+Enter or Ctrl+Enter: newline
              if (e.shiftKey || e.ctrlKey) return;
              e.preventDefault();
              void send();
            }}
          />

          <button
            className={`sendButton ${canSend ? "active" : ""} ${busy ? "loading" : ""}`}
            type="button"
            disabled={!canSend}
            onClick={() => void send()}
            aria-label="发送"
          >
            {busy ? <LoadingSpinner /> : <SendIcon />}
          </button>
        </div>

        <div className="composerFooter">
          <span className="composerHint">
            <kbd>Enter</kbd> 发送 · <kbd>Shift + Enter</kbd> 换行
          </span>
        </div>
      </div>
    </div>
  );
}
