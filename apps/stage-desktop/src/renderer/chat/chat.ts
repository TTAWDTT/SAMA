export function setupChat(opts: {
  historyEl: HTMLDivElement;
  inputEl: HTMLInputElement;
  sendBtn: HTMLButtonElement;
  hintEl?: HTMLDivElement;
  statusEl?: HTMLDivElement;
}) {
  const { historyEl, inputEl, sendBtn, hintEl, statusEl } = opts;

  const setStatus = (text: string) => {
    if (!statusEl) return;
    statusEl.textContent = text;
  };

  if (hintEl) {
    hintEl.textContent = "回复会显示在角色旁的气泡中（不是在这个窗口里）。";
  }

  const addUser = (text: string) => {
    const el = document.createElement("div");
    el.className = "msg user";
    el.textContent = text;
    historyEl.appendChild(el);
    historyEl.scrollTop = historyEl.scrollHeight;
  };

  const send = async () => {
    const msg = inputEl.value.trim();
    if (!msg) return;
    inputEl.value = "";
    addUser(msg);

    sendBtn.disabled = true;
    setStatus("发送中…");
    try {
      await window.stageDesktop.chatInvoke(msg);
      setStatus("已发送。SAMA 会用气泡回复。");
    } catch (err) {
      setStatus("发送失败：我这边好像卡了一下…");
      console.warn(err);
    } finally {
      sendBtn.disabled = false;
      inputEl.focus();
      window.setTimeout(() => setStatus(""), 2200);
    }
  };

  window.addEventListener("beforeunload", () => {
    window.stageDesktop.sendUserInteraction({
      type: "USER_INTERACTION",
      ts: Date.now(),
      event: "CLOSE_CHAT"
    });
  });

  window.stageDesktop.sendUserInteraction({
    type: "USER_INTERACTION",
    ts: Date.now(),
    event: "OPEN_CHAT"
  });

  sendBtn.addEventListener("click", () => void send());
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  });
}
