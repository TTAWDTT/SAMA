export function setupQuickSend(opts: { inputEl: HTMLTextAreaElement; sendBtnEl?: HTMLButtonElement | null }) {
  const { inputEl, sendBtnEl } = opts;

  const api: any = (window as any).stageDesktop;

  const flashPlaceholder = (text: string, ms: number) => {
    const prev = inputEl.placeholder;
    inputEl.placeholder = text;
    window.setTimeout(() => {
      // only revert if user hasn't changed it meanwhile
      if (inputEl.placeholder === text) inputEl.placeholder = prev;
    }, Math.max(300, ms));
  };

  const send = async () => {
    const msg = inputEl.value.trim();
    if (!msg) return;
    inputEl.value = "";
    inputEl.focus();

    if (!api || typeof api.chatInvoke !== "function") {
      flashPlaceholder("preload API 缺失：无法发送", 2200);
      return;
    }

    try {
      await api.chatInvoke(msg);
      // Replies are shown in bubbles; main chat view will sync via chat log.
      flashPlaceholder("已发送（回复在气泡）", 900);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      flashPlaceholder(`发送失败：${message}`, 2400);
    }
  };

  // Track user interaction so proactive "ignored" logic doesn't misfire.
  try {
    api?.sendUserInteraction?.({ type: "USER_INTERACTION", ts: Date.now(), event: "OPEN_CHAT" });
  } catch {}
  window.addEventListener("beforeunload", () => {
    try {
      api?.sendUserInteraction?.({ type: "USER_INTERACTION", ts: Date.now(), event: "CLOSE_CHAT" });
    } catch {}
  });

  inputEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (e.shiftKey) return; // Shift+Enter: newline
    e.preventDefault();
    void send();
  });

  if (sendBtnEl) {
    sendBtnEl.addEventListener("click", (e) => {
      e.preventDefault();
      void send();
    });
  }

  // Focus on open (fast window).
  inputEl.focus();
}

