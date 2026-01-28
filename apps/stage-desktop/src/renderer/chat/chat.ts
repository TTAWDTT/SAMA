export function setupChat(opts: {
  historyEl: HTMLDivElement;
  inputEl: HTMLInputElement;
  sendBtn: HTMLButtonElement;
}) {
  const { historyEl, inputEl, sendBtn } = opts;

  const add = (role: "user" | "bot", text: string) => {
    const el = document.createElement("div");
    el.className = `msg ${role === "user" ? "user" : "bot"}`;
    el.textContent = text;
    historyEl.appendChild(el);
    historyEl.scrollTop = historyEl.scrollHeight;
  };

  const send = async () => {
    const msg = inputEl.value.trim();
    if (!msg) return;
    inputEl.value = "";
    add("user", msg);

    sendBtn.disabled = true;
    try {
      const resp = await window.stageDesktop.chatInvoke(msg);
      add("bot", resp.message);
    } catch (err) {
      add("bot", "我这边好像卡了一下…");
      console.warn(err);
    } finally {
      sendBtn.disabled = false;
      inputEl.focus();
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

