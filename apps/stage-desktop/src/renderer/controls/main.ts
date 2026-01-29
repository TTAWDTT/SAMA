import type { ChatLogEntry, ChatLogMessage } from "@sama/shared";

type LlmConfig = {
  provider?: string;
  openai?: { apiKey?: string; model?: string; baseUrl?: string };
  deepseek?: { apiKey?: string; model?: string; baseUrl?: string };
  aistudio?: { apiKey?: string; model?: string; baseUrl?: string };
};

type StageDesktopApi = {
  getAppInfo?: () => Promise<{ vrmLocked: boolean; llmProvider: string }>;
  onChatLog?: (cb: (msg: ChatLogMessage) => void) => () => void;
  chatInvoke?: (message: string) => Promise<any>;
  sendUserInteraction?: (i: any) => void;
  getLlmConfig?: () => Promise<{ stored: LlmConfig | null; effective: LlmConfig | null; provider: string }>;
  setLlmConfig?: (cfg: LlmConfig) => Promise<{ ok: boolean; provider?: string; message?: string }>;
};

function getApi(): StageDesktopApi {
  return (window as any).stageDesktop as any;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function formatTime(ts: number) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function isNearBottom(el: HTMLElement, thresholdPx = 90) {
  const gap = el.scrollHeight - (el.scrollTop + el.clientHeight);
  return gap < thresholdPx;
}

function scrollToBottom(el: HTMLElement) {
  el.scrollTop = el.scrollHeight;
}

const app = (() => {
  const el = document.getElementById("app");
  if (!(el instanceof HTMLDivElement)) throw new Error("missing #app");
  return el;
})();

const settingsBtn = (() => {
  const el = document.getElementById("settingsBtn");
  if (!(el instanceof HTMLButtonElement)) throw new Error("missing #settingsBtn");
  return el;
})();

const backBtn = (() => {
  const el = document.getElementById("backBtn");
  if (!(el instanceof HTMLButtonElement)) throw new Error("missing #backBtn");
  return el;
})();

const llmText = (() => {
  const el = document.getElementById("llmText");
  if (!(el instanceof HTMLSpanElement)) throw new Error("missing #llmText");
  return el;
})();

const timeline = (() => {
  const el = document.getElementById("timeline");
  if (!(el instanceof HTMLDivElement)) throw new Error("missing #timeline");
  return el;
})();

const input = (() => {
  const el = document.getElementById("chatInput");
  if (!(el instanceof HTMLTextAreaElement)) throw new Error("missing #chatInput");
  return el;
})();

const sendBtn = (() => {
  const el = document.getElementById("sendBtn");
  if (!(el instanceof HTMLButtonElement)) throw new Error("missing #sendBtn");
  return el;
})();

const toast = (() => {
  const el = document.getElementById("toast");
  if (!(el instanceof HTMLDivElement)) throw new Error("missing #toast");
  return el;
})();

const providerEl = (() => {
  const el = document.getElementById("provider");
  if (!(el instanceof HTMLSelectElement)) throw new Error("missing #provider");
  return el;
})();
const openaiKeyEl = (() => {
  const el = document.getElementById("openaiKey");
  if (!(el instanceof HTMLInputElement)) throw new Error("missing #openaiKey");
  return el;
})();
const openaiModelEl = (() => {
  const el = document.getElementById("openaiModel");
  if (!(el instanceof HTMLInputElement)) throw new Error("missing #openaiModel");
  return el;
})();
const openaiBaseUrlEl = (() => {
  const el = document.getElementById("openaiBaseUrl");
  if (!(el instanceof HTMLInputElement)) throw new Error("missing #openaiBaseUrl");
  return el;
})();
const deepseekKeyEl = (() => {
  const el = document.getElementById("deepseekKey");
  if (!(el instanceof HTMLInputElement)) throw new Error("missing #deepseekKey");
  return el;
})();
const deepseekModelEl = (() => {
  const el = document.getElementById("deepseekModel");
  if (!(el instanceof HTMLInputElement)) throw new Error("missing #deepseekModel");
  return el;
})();
const deepseekBaseUrlEl = (() => {
  const el = document.getElementById("deepseekBaseUrl");
  if (!(el instanceof HTMLInputElement)) throw new Error("missing #deepseekBaseUrl");
  return el;
})();
const aistudioKeyEl = (() => {
  const el = document.getElementById("aistudioKey");
  if (!(el instanceof HTMLInputElement)) throw new Error("missing #aistudioKey");
  return el;
})();
const aistudioModelEl = (() => {
  const el = document.getElementById("aistudioModel");
  if (!(el instanceof HTMLInputElement)) throw new Error("missing #aistudioModel");
  return el;
})();
const aistudioBaseUrlEl = (() => {
  const el = document.getElementById("aistudioBaseUrl");
  if (!(el instanceof HTMLInputElement)) throw new Error("missing #aistudioBaseUrl");
  return el;
})();
const saveLlmEl = (() => {
  const el = document.getElementById("saveLlm");
  if (!(el instanceof HTMLButtonElement)) throw new Error("missing #saveLlm");
  return el;
})();
const reloadLlmEl = (() => {
  const el = document.getElementById("reloadLlm");
  if (!(el instanceof HTMLButtonElement)) throw new Error("missing #reloadLlm");
  return el;
})();

let toastTimer: number | null = null;
function showToast(message: string, opts?: { timeoutMs?: number }) {
  toast.textContent = message;
  toast.setAttribute("data-show", message ? "1" : "0");
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  const ms = clamp(Number(opts?.timeoutMs ?? 2200), 500, 9000);
  toastTimer = window.setTimeout(() => {
    toastTimer = null;
    toast.setAttribute("data-show", "0");
  }, ms);
}

function setView(view: "chat" | "settings") {
  app.setAttribute("data-view", view);
  if (view === "chat") {
    input.focus();
  }
}

function renderEmpty() {
  timeline.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "empty";
  const title = document.createElement("div");
  title.className = "emptyTitle";
  title.textContent = "SAMA";
  const desc = document.createElement("div");
  desc.className = "emptyDesc";
  desc.textContent = "在这里发消息。SAMA 会同时在气泡和本窗口里回复。";
  empty.append(title, desc);
  timeline.appendChild(empty);
}

function createMessageEl(entry: ChatLogEntry) {
  const row = document.createElement("div");
  row.className = `msgRow ${entry.role === "user" ? "user" : "assistant"}`;

  const card = document.createElement("div");
  card.className = `msg ${entry.role === "user" ? "user" : "assistant"}`;

  const header = document.createElement("div");
  header.className = "msgHeader";

  const who = document.createElement("div");
  who.className = "msgWho";
  who.textContent = entry.role === "user" ? "你" : "SAMA";

  const time = document.createElement("div");
  time.className = "msgTime";
  time.textContent = formatTime(entry.ts);

  const body = document.createElement("div");
  body.className = "msgBody";
  body.textContent = entry.content;

  header.append(who, time);
  card.append(header, body);
  row.appendChild(card);
  return row;
}

let chatEntries: ChatLogEntry[] = [];

function renderAll(entries: ChatLogEntry[]) {
  chatEntries = [...entries];
  if (chatEntries.length === 0) {
    renderEmpty();
    return;
  }

  timeline.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const e of chatEntries) frag.appendChild(createMessageEl(e));
  timeline.appendChild(frag);
  scrollToBottom(timeline);
}

function appendOne(entry: ChatLogEntry) {
  const shouldStick = isNearBottom(timeline);

  // Replace empty state if present
  if (chatEntries.length === 0) timeline.innerHTML = "";

  chatEntries.push(entry);
  // Keep the DOM manageable.
  if (chatEntries.length > 500) chatEntries = chatEntries.slice(-420);

  timeline.appendChild(createMessageEl(entry));
  if (shouldStick) scrollToBottom(timeline);
}

function autosizeInput() {
  input.style.height = "0px";
  input.style.height = `${Math.max(44, Math.min(168, input.scrollHeight))}px`;
}

function updateSendEnabled() {
  sendBtn.disabled = !input.value.trim();
}

async function sendMessage() {
  const api = getApi();
  if (!api || typeof api.chatInvoke !== "function") {
    showToast("preload API 缺失：无法发送消息");
    return;
  }

  const msg = input.value.trim();
  if (!msg) return;
  input.value = "";
  autosizeInput();
  updateSendEnabled();
  input.focus();

  try {
    // The main process will broadcast CHAT_LOG_APPEND immediately (user message),
    // then broadcast assistant reply later. This keeps all windows in sync.
    await api.chatInvoke(msg);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showToast(`发送失败：${message}`, { timeoutMs: 5200 });
  }
}

async function refreshLlmBadge() {
  const api = getApi();
  if (!api || typeof api.getAppInfo !== "function") {
    llmText.textContent = "LLM: preload missing";
    return;
  }
  try {
    const info = await api.getAppInfo();
    const provider = String(info?.llmProvider ?? "unknown") || "unknown";
    llmText.textContent = `LLM: ${provider}`;
  } catch {
    llmText.textContent = "LLM: unknown";
  }
}

async function loadLlmConfigIntoForm() {
  const api = getApi();
  if (!api || typeof api.getLlmConfig !== "function") {
    showToast("preload API 缺失：无法读取 LLM 配置", { timeoutMs: 4200 });
    return;
  }

  try {
    const res = await api.getLlmConfig();
    const cfg: LlmConfig = (res?.stored ?? null) || {};

    providerEl.value = String(cfg.provider ?? "auto") || "auto";

    openaiKeyEl.value = String(cfg.openai?.apiKey ?? "");
    openaiModelEl.value = String(cfg.openai?.model ?? "");
    openaiBaseUrlEl.value = String(cfg.openai?.baseUrl ?? "");

    deepseekKeyEl.value = String(cfg.deepseek?.apiKey ?? "");
    deepseekModelEl.value = String(cfg.deepseek?.model ?? "");
    deepseekBaseUrlEl.value = String(cfg.deepseek?.baseUrl ?? "");

    aistudioKeyEl.value = String(cfg.aistudio?.apiKey ?? "");
    aistudioModelEl.value = String(cfg.aistudio?.model ?? "");
    aistudioBaseUrlEl.value = String(cfg.aistudio?.baseUrl ?? "");

    showToast("已读取 LLM 配置", { timeoutMs: 1400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showToast(`读取失败：${message}`, { timeoutMs: 5200 });
  }
}

async function saveLlmConfigFromForm() {
  const api = getApi();
  if (!api || typeof api.setLlmConfig !== "function") {
    showToast("preload API 缺失：无法保存 LLM 配置", { timeoutMs: 4200 });
    return;
  }

  const cfg: LlmConfig = {
    provider: providerEl.value,
    openai: { apiKey: openaiKeyEl.value, model: openaiModelEl.value, baseUrl: openaiBaseUrlEl.value },
    deepseek: { apiKey: deepseekKeyEl.value, model: deepseekModelEl.value, baseUrl: deepseekBaseUrlEl.value },
    aistudio: { apiKey: aistudioKeyEl.value, model: aistudioModelEl.value, baseUrl: aistudioBaseUrlEl.value }
  };

  try {
    const res = await api.setLlmConfig(cfg);
    if (!res?.ok) {
      showToast(`保存失败：${String(res?.message ?? "unknown error")}`, { timeoutMs: 5200 });
      return;
    }
    await refreshLlmBadge();
    showToast(`已保存（provider=${String(res?.provider ?? "ok")}）`, { timeoutMs: 2000 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showToast(`保存失败：${message}`, { timeoutMs: 5200 });
  }
}

function boot() {
  settingsBtn.addEventListener("click", () => {
    setView("settings");
    void loadLlmConfigIntoForm();
  });
  backBtn.addEventListener("click", () => setView("chat"));

  sendBtn.addEventListener("click", () => void sendMessage());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  });
  input.addEventListener("input", () => {
    autosizeInput();
    updateSendEnabled();
  });

  saveLlmEl.addEventListener("click", () => void saveLlmConfigFromForm());
  reloadLlmEl.addEventListener("click", () => void loadLlmConfigIntoForm());

  autosizeInput();
  updateSendEnabled();
  input.focus();

  void refreshLlmBadge();

  const api = getApi();
  try {
    api?.sendUserInteraction?.({ type: "USER_INTERACTION", ts: Date.now(), event: "OPEN_CHAT" });
  } catch {}
  window.addEventListener("beforeunload", () => {
    try {
      getApi()?.sendUserInteraction?.({ type: "USER_INTERACTION", ts: Date.now(), event: "CLOSE_CHAT" });
    } catch {}
  });
  if (api && typeof api.onChatLog === "function") {
    api.onChatLog((msg: ChatLogMessage) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "CHAT_LOG_SYNC") {
        renderAll(Array.isArray((msg as any).entries) ? (msg as any).entries : []);
        return;
      }
      if (msg.type === "CHAT_LOG_APPEND") {
        const entry = (msg as any).entry as ChatLogEntry | undefined;
        if (!entry || typeof entry !== "object") return;
        if (typeof (entry as any).content !== "string") return;
        appendOne(entry);
        return;
      }
    });
  } else {
    // Still usable in dev, but without sync.
    renderEmpty();
    showToast("preload API 缺失：无法同步聊天记录", { timeoutMs: 5200 });
  }
}

try {
  boot();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  showToast(`启动失败：${message}`, { timeoutMs: 9000 });
  throw err;
}
