export function setupChat(opts: {
  historyEl: HTMLDivElement;
  inputEl: HTMLTextAreaElement;
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
    hintEl.textContent =
      "这里是输入窗口；SAMA 的回复会显示在角色旁的气泡中（不是在这个窗口里）。\n如果没看到气泡：先确认你是从托盘/快捷键打开的窗口，而不是浏览器。";
  }

  const addUser = (text: string) => {
    const el = document.createElement("div");
    el.className = "msg user";
    el.textContent = text;
    historyEl.appendChild(el);
    historyEl.scrollTop = historyEl.scrollHeight;
  };

  let sending = false;
  const autosize = () => {
    // Smooth textarea growth (clamped in CSS via max-height).
    inputEl.style.height = "0px";
    inputEl.style.height = `${Math.max(44, inputEl.scrollHeight)}px`;
  };
  const updateSendEnabled = () => {
    const hasText = Boolean(inputEl.value.trim());
    sendBtn.disabled = sending || !hasText;
  };

  const send = async () => {
    const msg = inputEl.value.trim();
    if (!msg) return;
    inputEl.value = "";
    autosize();
    updateSendEnabled();
    addUser(msg);

    sending = true;
    updateSendEnabled();
    setStatus("发送中…");
    try {
      const resp = await window.stageDesktop.chatInvoke(msg);
      const reply = String((resp as any)?.message ?? "").trim();
      const compact = reply.replace(/\s+/g, "");

      // Keep replies in bubbles, but surface a tiny diagnostic hint if the response looks "stuck".
      if (compact === "我听到了" || compact === "我听见了" || compact === "收到" || compact === "嗯") {
        setStatus(`已返回：${reply}（提示：回复过短/重复时，检查 LLM 配置或看看 Controls 的 LLM 状态）`);
      } else {
        setStatus("已发送。SAMA 会用气泡回复。");
      }
    } catch (err) {
      setStatus("发送失败：我这边好像卡了一下…");
      console.warn(err);
    } finally {
      sending = false;
      updateSendEnabled();
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

  inputEl.addEventListener("input", () => {
    autosize();
    updateSendEnabled();
  });

  // Initial
  autosize();
  updateSendEnabled();
  inputEl.focus();
}
