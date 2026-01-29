import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

export function Composer(props: { disabled: boolean; onSend: (text: string) => Promise<void> | void }) {
  const { disabled, onSend } = props;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const canSend = useMemo(() => !disabled && !sending && Boolean(text.trim()), [disabled, sending, text]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.max(44, Math.min(168, el.scrollHeight))}px`;
  }, [text]);

  useEffect(() => {
    // Focus on first mount
    inputRef.current?.focus();
  }, []);

  async function send() {
    const msg = text.trim();
    if (!msg) return;
    if (sending) return;
    setSending(true);
    setText("");
    try {
      await onSend(msg);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
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
          value={text}
          placeholder="Message…"
          spellCheck={false}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            if (e.shiftKey) return; // Shift+Enter: newline
            e.preventDefault();
            void send();
          }}
        />

        <button className="btn btnPrimary" type="button" disabled={!canSend} onClick={() => void send()}>
          {sending ? "…" : "Send"}
        </button>
      </div>

      <div className="composerHint">Enter 发送，Shift+Enter 换行</div>
    </div>
  );
}

