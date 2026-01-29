import type { ChatLogEntry, ChatLogMessage, PetControlMessage, PetControlResult, PetStateMessage } from "@sama/shared";

type LlmConfig = {
  provider?: string;
  openai?: { apiKey?: string; model?: string; baseUrl?: string };
  deepseek?: { apiKey?: string; model?: string; baseUrl?: string };
  aistudio?: { apiKey?: string; model?: string; baseUrl?: string };
};

type StageDesktopApi = {
  getAppInfo?: () => Promise<{ vrmLocked: boolean; llmProvider: string }>;
  onChatLog?: (cb: (msg: ChatLogMessage) => void) => () => void;
  getChatLog?: () => Promise<ChatLogMessage>;
  chatInvoke?: (message: string) => Promise<any>;
  sendUserInteraction?: (i: any) => void;
  // Pet control (VRMA / motion tuning)
  sendPetControl?: (m: PetControlMessage) => void;
  onPetControlResult?: (cb: (r: PetControlResult) => void) => () => void;
  onPetState?: (cb: (s: PetStateMessage) => void) => () => void;
  getLlmConfig?: () => Promise<{ stored: LlmConfig | null; effective: LlmConfig | null; provider: string }>;
  setLlmConfig?: (cfg: LlmConfig) => Promise<{ ok: boolean; provider?: string; message?: string }>;

  // Long-term memory (SQLite) helpers.
  getMemoryStats?: () => Promise<{ enabled: boolean; chatCount: number; noteCount: number }>;
  listMemoryNotes?: (
    limit: number
  ) => Promise<{ enabled: boolean; notes: { kind: string; content: string; updatedTs: number }[] }>;
  addMemoryNote?: (content: string) => Promise<{ ok: boolean }>;
  clearChatHistory?: () => Promise<{ ok: boolean }>;
  clearMemoryNotes?: () => Promise<{ ok: boolean }>;
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

const llmRuntimeEl = (() => {
  const el = document.getElementById("llmRuntime");
  if (!(el instanceof HTMLDivElement)) throw new Error("missing #llmRuntime");
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
const providerHelpEl = (() => {
  const el = document.getElementById("providerHelp");
  if (!(el instanceof HTMLDivElement)) throw new Error("missing #providerHelp");
  return el;
})();
const openaiDetailsEl = (() => {
  const el = document.getElementById("openaiDetails");
  if (!(el instanceof HTMLDetailsElement)) throw new Error("missing #openaiDetails");
  return el;
})();
const deepseekDetailsEl = (() => {
  const el = document.getElementById("deepseekDetails");
  if (!(el instanceof HTMLDetailsElement)) throw new Error("missing #deepseekDetails");
  return el;
})();
const aistudioDetailsEl = (() => {
  const el = document.getElementById("aistudioDetails");
  if (!(el instanceof HTMLDetailsElement)) throw new Error("missing #aistudioDetails");
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

// Long-term memory (settings view)
const memoryStatusEl = (() => {
  const el = document.getElementById("memoryStatus");
  if (!(el instanceof HTMLDivElement)) throw new Error("missing #memoryStatus");
  return el;
})();
const memoryCountsEl = (() => {
  const el = document.getElementById("memoryCounts");
  if (!(el instanceof HTMLSpanElement)) throw new Error("missing #memoryCounts");
  return el;
})();
const memoryNoteInputEl = (() => {
  const el = document.getElementById("memoryNoteInput");
  if (!(el instanceof HTMLInputElement)) throw new Error("missing #memoryNoteInput");
  return el;
})();
const memoryNoteAddEl = (() => {
  const el = document.getElementById("memoryNoteAdd");
  if (!(el instanceof HTMLButtonElement)) throw new Error("missing #memoryNoteAdd");
  return el;
})();
const refreshMemoryNotesEl = (() => {
  const el = document.getElementById("refreshMemoryNotes");
  if (!(el instanceof HTMLButtonElement)) throw new Error("missing #refreshMemoryNotes");
  return el;
})();
const memoryNotesEmptyEl = (() => {
  const el = document.getElementById("memoryNotesEmpty");
  if (!(el instanceof HTMLDivElement)) throw new Error("missing #memoryNotesEmpty");
  return el;
})();
const memoryNotesListEl = (() => {
  const el = document.getElementById("memoryNotesList");
  if (!(el instanceof HTMLDivElement)) throw new Error("missing #memoryNotesList");
  return el;
})();
const clearChatHistoryEl = (() => {
  const el = document.getElementById("clearChatHistory");
  if (!(el instanceof HTMLButtonElement)) throw new Error("missing #clearChatHistory");
  return el;
})();
const clearMemoryNotesEl = (() => {
  const el = document.getElementById("clearMemoryNotes");
  if (!(el instanceof HTMLButtonElement)) throw new Error("missing #clearMemoryNotes");
  return el;
})();

// Motion / VRMA controls (settings view)
const pickVrmaBtn = (() => {
  const el = document.getElementById("pickVrma");
  if (!(el instanceof HTMLButtonElement)) throw new Error("missing #pickVrma");
  return el;
})();
const stopVrmaBtn = (() => {
  const el = document.getElementById("stopVrma");
  if (!(el instanceof HTMLButtonElement)) throw new Error("missing #stopVrma");
  return el;
})();
const setIdleFromLastBtn = (() => {
  const el = document.getElementById("setIdleFromLast");
  if (!(el instanceof HTMLButtonElement)) throw new Error("missing #setIdleFromLast");
  return el;
})();
const setWalkFromLastBtn = (() => {
  const el = document.getElementById("setWalkFromLast");
  if (!(el instanceof HTMLButtonElement)) throw new Error("missing #setWalkFromLast");
  return el;
})();
const vrmaStatusEl = (() => {
  const el = document.getElementById("vrmaStatus");
  if (!(el instanceof HTMLDivElement)) throw new Error("missing #vrmaStatus");
  return el;
})();
const slotStatusEl = (() => {
  const el = document.getElementById("slotStatus");
  if (!(el instanceof HTMLSpanElement)) throw new Error("missing #slotStatus");
  return el;
})();
const vrmaSpeedEl = (() => {
  const el = document.getElementById("vrmaSpeed");
  if (!(el instanceof HTMLInputElement)) throw new Error("missing #vrmaSpeed");
  return el;
})();
const vrmaSpeedValueEl = (() => {
  const el = document.getElementById("vrmaSpeedValue");
  if (!(el instanceof HTMLDivElement)) throw new Error("missing #vrmaSpeedValue");
  return el;
})();
const vrmaPausedEl = (() => {
  const el = document.getElementById("vrmaPaused");
  if (!(el instanceof HTMLInputElement)) throw new Error("missing #vrmaPaused");
  return el;
})();
const vrmaSaveNameEl = (() => {
  const el = document.getElementById("vrmaSaveName");
  if (!(el instanceof HTMLInputElement)) throw new Error("missing #vrmaSaveName");
  return el;
})();
const saveVrmaEl = (() => {
  const el = document.getElementById("saveVrma");
  if (!(el instanceof HTMLButtonElement)) throw new Error("missing #saveVrma");
  return el;
})();
const refreshVrmaLibEl = (() => {
  const el = document.getElementById("refreshVrmaLib");
  if (!(el instanceof HTMLButtonElement)) throw new Error("missing #refreshVrmaLib");
  return el;
})();
const vrmaLibEmptyEl = (() => {
  const el = document.getElementById("vrmaLibEmpty");
  if (!(el instanceof HTMLDivElement)) throw new Error("missing #vrmaLibEmpty");
  return el;
})();
const vrmaLibListEl = (() => {
  const el = document.getElementById("vrmaLibList");
  if (!(el instanceof HTMLDivElement)) throw new Error("missing #vrmaLibList");
  return el;
})();

const idleEnabledEl = (() => {
  const el = document.getElementById("idleEnabled");
  if (!(el instanceof HTMLInputElement)) throw new Error("missing #idleEnabled");
  return el;
})();
const idleStrengthEl = (() => {
  const el = document.getElementById("idleStrength");
  if (!(el instanceof HTMLInputElement)) throw new Error("missing #idleStrength");
  return el;
})();
const idleStrengthValueEl = (() => {
  const el = document.getElementById("idleStrengthValue");
  if (!(el instanceof HTMLDivElement)) throw new Error("missing #idleStrengthValue");
  return el;
})();
const idleSpeedEl = (() => {
  const el = document.getElementById("idleSpeed");
  if (!(el instanceof HTMLInputElement)) throw new Error("missing #idleSpeed");
  return el;
})();
const idleSpeedValueEl = (() => {
  const el = document.getElementById("idleSpeedValue");
  if (!(el instanceof HTMLDivElement)) throw new Error("missing #idleSpeedValue");
  return el;
})();

const walkEnabledEl = (() => {
  const el = document.getElementById("walkEnabled");
  if (!(el instanceof HTMLInputElement)) throw new Error("missing #walkEnabled");
  return el;
})();
const walkSpeedEl = (() => {
  const el = document.getElementById("walkSpeed");
  if (!(el instanceof HTMLInputElement)) throw new Error("missing #walkSpeed");
  return el;
})();
const walkSpeedValueEl = (() => {
  const el = document.getElementById("walkSpeedValue");
  if (!(el instanceof HTMLDivElement)) throw new Error("missing #walkSpeedValue");
  return el;
})();
const walkStrideEl = (() => {
  const el = document.getElementById("walkStride");
  if (!(el instanceof HTMLInputElement)) throw new Error("missing #walkStride");
  return el;
})();
const walkStrideValueEl = (() => {
  const el = document.getElementById("walkStrideValue");
  if (!(el instanceof HTMLDivElement)) throw new Error("missing #walkStrideValue");
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

  // Extra robustness: if the push channel is missing (or a message was missed),
  // pull the current log once so the timeline doesn't stay empty.
  try {
    if (typeof api.getChatLog === "function") {
      const sync = await api.getChatLog();
      if (sync && sync.type === "CHAT_LOG_SYNC") {
        renderAll(Array.isArray((sync as any).entries) ? (sync as any).entries : []);
      }
    }
  } catch {}
}

async function refreshLlmRuntime() {
  const api = getApi();
  if (!api || typeof api.getAppInfo !== "function") {
    llmRuntimeEl.textContent = "当前运行：preload missing";
    return;
  }
  try {
    const info = await api.getAppInfo();
    const provider = String(info?.llmProvider ?? "unknown") || "unknown";
    llmRuntimeEl.textContent = `当前运行：${provider}`;
  } catch {
    llmRuntimeEl.textContent = "当前运行：unknown";
  }
}

function setStatusLine(el: HTMLElement, opts: { text: string; enabled?: boolean }) {
  const textEl = el.querySelector(".statusText");
  if (textEl instanceof HTMLElement) textEl.textContent = opts.text;

  const dotEl = el.querySelector(".statusDot");
  if (!(dotEl instanceof HTMLElement)) return;

  if (opts.enabled === true) {
    dotEl.style.background = "rgba(120, 140, 93, 0.75)";
    dotEl.style.boxShadow = "0 0 0 4px rgba(120, 140, 93, 0.14)";
    return;
  }
  if (opts.enabled === false) {
    dotEl.style.background = "rgba(20, 20, 19, 0.35)";
    dotEl.style.boxShadow = "0 0 0 4px rgba(20, 20, 19, 0.10)";
    return;
  }

  dotEl.style.background = "";
  dotEl.style.boxShadow = "";
}

function renderMemoryNotes(notes: { kind: string; content: string; updatedTs: number }[]) {
  memoryNotesListEl.innerHTML = "";
  if (!Array.isArray(notes) || notes.length === 0) {
    memoryNotesEmptyEl.style.display = "block";
    return;
  }
  memoryNotesEmptyEl.style.display = "none";

  const frag = document.createDocumentFragment();
  for (const n of notes) {
    const row = document.createElement("div");
    row.className = "libItem";

    const left = document.createElement("div");
    left.className = "libLeft";

    const name = document.createElement("div");
    name.className = "libName";
    name.textContent = String(n?.content ?? "");

    const meta = document.createElement("div");
    meta.className = "libMeta";
    const kind = String(n?.kind ?? "note");
    const when = new Date(Number(n?.updatedTs ?? 0) || Date.now()).toLocaleString();
    meta.textContent = `${kind} · ${when}`;

    left.append(name, meta);
    row.append(left);
    frag.appendChild(row);
  }
  memoryNotesListEl.appendChild(frag);
}

async function refreshMemorySection() {
  const api = getApi();
  if (!api || typeof api.getMemoryStats !== "function") {
    setStatusLine(memoryStatusEl, { text: "状态：preload missing", enabled: false });
    memoryCountsEl.textContent = "chat - · notes -";
    renderMemoryNotes([]);
    return;
  }

  try {
    const stats = await api.getMemoryStats();
    const enabled = Boolean(stats?.enabled);
    setStatusLine(memoryStatusEl, { text: enabled ? "状态：已启用" : "状态：未启用（SQLite 不可用）", enabled });
    memoryCountsEl.textContent = `chat ${Number(stats?.chatCount ?? 0) || 0} · notes ${Number(stats?.noteCount ?? 0) || 0}`;
  } catch {
    setStatusLine(memoryStatusEl, { text: "状态：unknown", enabled: false });
    memoryCountsEl.textContent = "chat - · notes -";
  }

  if (!api || typeof api.listMemoryNotes !== "function") return;
  try {
    const res = await api.listMemoryNotes(14);
    renderMemoryNotes(Array.isArray(res?.notes) ? res.notes : []);
  } catch {
    renderMemoryNotes([]);
  }
}

async function addMemoryNoteFromInput() {
  const api = getApi();
  if (!api || typeof api.addMemoryNote !== "function") {
    showToast("preload API 缺失：无法写入记忆", { timeoutMs: 4200 });
    return;
  }

  const content = memoryNoteInputEl.value.trim();
  if (!content) {
    memoryNoteInputEl.focus();
    showToast("请输入要记住的内容", { timeoutMs: 1600 });
    return;
  }

  try {
    const res = await api.addMemoryNote(content);
    if (!res?.ok) {
      showToast("记忆写入失败（可能未启用本地 SQLite）", { timeoutMs: 5200 });
      return;
    }
    memoryNoteInputEl.value = "";
    showToast("已记住", { timeoutMs: 1400 });
    void refreshMemorySection();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showToast(`记忆写入失败：${message}`, { timeoutMs: 5200 });
  }
}

function setDetailsVisible(el: HTMLDetailsElement, visible: boolean) {
  el.style.display = visible ? "" : "none";
}

function updateProviderPanels() {
  const provider = String(providerEl.value || "auto");
  if (provider === "off") {
    providerHelpEl.textContent = "已禁用：SAMA 会使用规则回复（不走 LLM）。";
    setDetailsVisible(openaiDetailsEl, false);
    setDetailsVisible(deepseekDetailsEl, false);
    setDetailsVisible(aistudioDetailsEl, false);
    openaiDetailsEl.open = false;
    deepseekDetailsEl.open = false;
    aistudioDetailsEl.open = false;
    return;
  }

  if (provider === "openai") {
    providerHelpEl.textContent = "选择 openai：只展示 OpenAI 配置。";
    setDetailsVisible(openaiDetailsEl, true);
    setDetailsVisible(deepseekDetailsEl, false);
    setDetailsVisible(aistudioDetailsEl, false);
    openaiDetailsEl.open = true;
    deepseekDetailsEl.open = false;
    aistudioDetailsEl.open = false;
    return;
  }
  if (provider === "deepseek") {
    providerHelpEl.textContent = "选择 deepseek：只展示 DeepSeek 配置。";
    setDetailsVisible(openaiDetailsEl, false);
    setDetailsVisible(deepseekDetailsEl, true);
    setDetailsVisible(aistudioDetailsEl, false);
    openaiDetailsEl.open = false;
    deepseekDetailsEl.open = true;
    aistudioDetailsEl.open = false;
    return;
  }
  if (provider === "aistudio") {
    providerHelpEl.textContent = "选择 aistudio：只展示 AIStudio/Gemini 配置。";
    setDetailsVisible(openaiDetailsEl, false);
    setDetailsVisible(deepseekDetailsEl, false);
    setDetailsVisible(aistudioDetailsEl, true);
    openaiDetailsEl.open = false;
    deepseekDetailsEl.open = false;
    aistudioDetailsEl.open = true;
    return;
  }

  // auto
  providerHelpEl.textContent = "auto：你可以填写任意一个 Key；SAMA 会自动选择可用的。";
  setDetailsVisible(openaiDetailsEl, true);
  setDetailsVisible(deepseekDetailsEl, true);
  setDetailsVisible(aistudioDetailsEl, true);
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

    updateProviderPanels();
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
    await refreshLlmRuntime();
    showToast(`已保存（provider=${String(res?.provider ?? "ok")}）`, { timeoutMs: 2000 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showToast(`保存失败：${message}`, { timeoutMs: 5200 });
  }
}

// --- Motion / VRMA (minimal but complete) -----------------------------------

type VrmaLibraryItem = {
  name: string;
  bytes: ArrayBuffer;
  createdAt: number;
  updatedAt: number;
};

const VRMA_DB_NAME = "sama.vrma.library";
const VRMA_DB_VERSION = 1;
const VRMA_STORE = "vrma";

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  return bytes.slice().buffer as ArrayBuffer;
}

function stripExtension(name: string) {
  return name.replace(/\.[^/.]+$/, "");
}

function normalizeVrmaName(name: string) {
  return name.trim().replace(/\s+/g, " ");
}

function openVrmaDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(VRMA_DB_NAME, VRMA_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(VRMA_STORE)) {
        db.createObjectStore(VRMA_STORE, { keyPath: "name" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
}

async function vrmaList(): Promise<VrmaLibraryItem[]> {
  const db = await openVrmaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VRMA_STORE, "readonly");
    const store = tx.objectStore(VRMA_STORE);
    const req = store.getAll();
    req.onsuccess = () => {
      const items = (req.result as VrmaLibraryItem[]) ?? [];
      items.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      resolve(items);
    };
    req.onerror = () => reject(req.error ?? new Error("indexedDB getAll failed"));
  });
}

async function vrmaGet(name: string): Promise<VrmaLibraryItem | null> {
  const db = await openVrmaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VRMA_STORE, "readonly");
    const store = tx.objectStore(VRMA_STORE);
    const req = store.get(name);
    req.onsuccess = () => resolve((req.result as VrmaLibraryItem) ?? null);
    req.onerror = () => reject(req.error ?? new Error("indexedDB get failed"));
  });
}

async function vrmaPut(item: VrmaLibraryItem): Promise<void> {
  const db = await openVrmaDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(VRMA_STORE, "readwrite");
    const store = tx.objectStore(VRMA_STORE);
    const req = store.put(item);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("indexedDB put failed"));
  });
}

async function vrmaDelete(name: string): Promise<void> {
  const db = await openVrmaDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(VRMA_STORE, "readwrite");
    const store = tx.objectStore(VRMA_STORE);
    const req = store.delete(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("indexedDB delete failed"));
  });
}

async function pickFileViaFileInput(accept: string): Promise<{ bytes: Uint8Array; fileName: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    document.body.appendChild(input);

    input.addEventListener(
      "change",
      async () => {
        try {
          const file = input.files?.[0];
          if (!file) {
            resolve(null);
            return;
          }
          const buf = await file.arrayBuffer();
          resolve({ bytes: new Uint8Array(buf), fileName: String(file.name ?? "") });
        } catch {
          resolve(null);
        } finally {
          input.remove();
        }
      },
      { once: true }
    );

    input.click();
  });
}

function fmtNum(n: number, digits: number) {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(clamp(digits, 0, 6));
}

type MotionUiSettingsV1 = {
  version: 1;
  vrma: { speed: number; paused: boolean };
  idle: { enabled: boolean; strength: number; speed: number };
  walk: { enabled: boolean; speed: number; stride: number };
};

const MOTION_UI_KEY = "sama.ui.motion.v1";

function loadMotionUiSettings(): MotionUiSettingsV1 {
  try {
    const raw = localStorage.getItem(MOTION_UI_KEY);
    const parsed = raw ? (JSON.parse(raw) as any) : null;
    if (!parsed || parsed.version !== 1) throw new Error("bad version");
    return {
      version: 1,
      vrma: {
        speed: clamp(Number(parsed?.vrma?.speed ?? 1), 0, 2),
        paused: Boolean(parsed?.vrma?.paused ?? false)
      },
      idle: {
        enabled: Boolean(parsed?.idle?.enabled ?? true),
        strength: clamp(Number(parsed?.idle?.strength ?? 1), 0, 1),
        speed: clamp(Number(parsed?.idle?.speed ?? 1), 0.2, 2)
      },
      walk: {
        enabled: Boolean(parsed?.walk?.enabled ?? true),
        speed: clamp(Number(parsed?.walk?.speed ?? 1), 0.2, 2),
        stride: clamp(Number(parsed?.walk?.stride ?? 0.75), 0, 1)
      }
    };
  } catch {
    return {
      version: 1,
      vrma: { speed: 1, paused: false },
      idle: { enabled: true, strength: 1, speed: 1 },
      walk: { enabled: true, speed: 1, stride: 0.75 }
    };
  }
}

function saveMotionUiSettings(s: MotionUiSettingsV1) {
  try {
    localStorage.setItem(MOTION_UI_KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

let motionUi = loadMotionUiSettings();

let lastVrmaBytes: Uint8Array | null = null;
let lastVrmaFileName = "";

const pendingPetResults = new Map<string, { resolve: (r: PetControlResult) => void; reject: (e: unknown) => void }>();
let petResultListenerInstalled = false;

function createReqId() {
  return `req_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
}

function installPetResultListener(api: StageDesktopApi) {
  if (petResultListenerInstalled) return;
  if (!api || typeof api.onPetControlResult !== "function") return;

  petResultListenerInstalled = true;
  api.onPetControlResult((res: PetControlResult) => {
    const pending = pendingPetResults.get(res.requestId);
    if (!pending) return;
    pendingPetResults.delete(res.requestId);
    pending.resolve(res);
  });
}

function sendPetControl(msg: PetControlMessage) {
  const api = getApi();
  if (!api || typeof api.sendPetControl !== "function") {
    showToast("preload API 缺失：无法控制动作/VRMA", { timeoutMs: 4200 });
    return false;
  }
  api.sendPetControl(msg);
  return true;
}

function sendPetControlWithResult(
  msg: PetControlMessage,
  opts?: { timeoutMs?: number }
): Promise<PetControlResult> {
  const api = getApi();
  installPetResultListener(api);
  const timeoutMs = clamp(Number(opts?.timeoutMs ?? 12_000), 800, 30_000);

  const requestId = (msg as any).requestId ? String((msg as any).requestId) : createReqId();
  (msg as any).requestId = requestId;

  return new Promise((resolve, reject) => {
    const ok = sendPetControl(msg);
    if (!ok) {
      reject(new Error("preload API missing"));
      return;
    }

    let timer: number | null = null;
    const done = (fn: (v: any) => void, v: any) => {
      if (timer !== null) window.clearTimeout(timer);
      pendingPetResults.delete(requestId);
      fn(v);
    };

    pendingPetResults.set(requestId, { resolve: (r) => done(resolve, r), reject: (e) => done(reject, e) });
    timer = window.setTimeout(() => {
      done(reject, new Error("Pet 无响应：请求超时"));
    }, timeoutMs);
  });
}

function setVrmaStatusText(s: string) {
  const el = vrmaStatusEl.querySelector(".statusText");
  if (el) el.textContent = s;
}

function updateMotionFormFromState() {
  vrmaSpeedEl.value = String(motionUi.vrma.speed);
  vrmaPausedEl.checked = motionUi.vrma.paused;
  vrmaSpeedValueEl.textContent = `${fmtNum(motionUi.vrma.speed, 2)}x`;

  idleEnabledEl.checked = motionUi.idle.enabled;
  idleStrengthEl.value = String(motionUi.idle.strength);
  idleStrengthValueEl.textContent = fmtNum(motionUi.idle.strength, 2);
  idleSpeedEl.value = String(motionUi.idle.speed);
  idleSpeedValueEl.textContent = `${fmtNum(motionUi.idle.speed, 2)}x`;

  walkEnabledEl.checked = motionUi.walk.enabled;
  walkSpeedEl.value = String(motionUi.walk.speed);
  walkSpeedValueEl.textContent = `${fmtNum(motionUi.walk.speed, 2)}x`;
  walkStrideEl.value = String(motionUi.walk.stride);
  walkStrideValueEl.textContent = fmtNum(motionUi.walk.stride, 2);
}

function applyMotionToPet() {
  // Apply stored settings at startup so users don't have to reopen a separate panel.
  sendPetControl({
    type: "PET_CONTROL",
    ts: Date.now(),
    action: "SET_VRMA_CONFIG",
    config: { speed: motionUi.vrma.speed, paused: motionUi.vrma.paused }
  } as any);
  sendPetControl({
    type: "PET_CONTROL",
    ts: Date.now(),
    action: "SET_IDLE_CONFIG",
    config: { enabled: motionUi.idle.enabled, strength: motionUi.idle.strength, speed: motionUi.idle.speed }
  } as any);
  sendPetControl({
    type: "PET_CONTROL",
    ts: Date.now(),
    action: "SET_WALK_CONFIG",
    config: { enabled: motionUi.walk.enabled, speed: motionUi.walk.speed, stride: motionUi.walk.stride }
  } as any);
}

let pendingVrmaCfg: any = {};
let vrmaCfgTimer: number | null = null;
function queueVrmaConfig(partial: any) {
  Object.assign(pendingVrmaCfg, partial);
  if (vrmaCfgTimer !== null) return;
  vrmaCfgTimer = window.setTimeout(() => {
    vrmaCfgTimer = null;
    const cfg = pendingVrmaCfg;
    pendingVrmaCfg = {};
    sendPetControl({ type: "PET_CONTROL", ts: Date.now(), action: "SET_VRMA_CONFIG", config: cfg } as any);
  }, 60);
}

let pendingIdleCfg: any = {};
let idleCfgTimer: number | null = null;
function queueIdleConfig(partial: any) {
  Object.assign(pendingIdleCfg, partial);
  if (idleCfgTimer !== null) return;
  idleCfgTimer = window.setTimeout(() => {
    idleCfgTimer = null;
    const cfg = pendingIdleCfg;
    pendingIdleCfg = {};
    sendPetControl({ type: "PET_CONTROL", ts: Date.now(), action: "SET_IDLE_CONFIG", config: cfg } as any);
  }, 60);
}

let pendingWalkCfg: any = {};
let walkCfgTimer: number | null = null;
function queueWalkConfig(partial: any) {
  Object.assign(pendingWalkCfg, partial);
  if (walkCfgTimer !== null) return;
  walkCfgTimer = window.setTimeout(() => {
    walkCfgTimer = null;
    const cfg = pendingWalkCfg;
    pendingWalkCfg = {};
    sendPetControl({ type: "PET_CONTROL", ts: Date.now(), action: "SET_WALK_CONFIG", config: cfg } as any);
  }, 60);
}

async function loadVrmaBytes(bytes: Uint8Array) {
  const res = await sendPetControlWithResult({
    type: "PET_CONTROL",
    ts: Date.now(),
    action: "LOAD_VRMA_BYTES",
    bytes
  } as any);

  if (!res.ok) throw new Error(String(res.message ?? "load failed"));
}

async function refreshVrmaLibrary() {
  try {
    const items = await vrmaList();
    vrmaLibListEl.innerHTML = "";

    if (!items.length) {
      vrmaLibEmptyEl.style.display = "block";
      return;
    }

    vrmaLibEmptyEl.style.display = "none";
    const frag = document.createDocumentFragment();

    for (const item of items) {
      const row = document.createElement("div");
      row.className = "libItem";

      const left = document.createElement("div");
      left.className = "libLeft";

      const name = document.createElement("div");
      name.className = "libName";
      name.textContent = item.name;

      const meta = document.createElement("div");
      meta.className = "libMeta";
      meta.textContent = `updated ${new Date(item.updatedAt || item.createdAt).toLocaleString()}`;

      left.append(name, meta);

      const actions = document.createElement("div");
      actions.className = "libActions";

      const playBtn = document.createElement("button");
      playBtn.className = "btn btnSm";
      playBtn.type = "button";
      playBtn.textContent = "播放";
      playBtn.addEventListener("click", async () => {
        try {
          const got = await vrmaGet(item.name);
          if (!got) throw new Error("not found");
          await loadVrmaBytes(new Uint8Array(got.bytes));
          showToast(`已播放：${item.name}`, { timeoutMs: 1600 });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          showToast(`播放失败：${msg}`, { timeoutMs: 5200 });
        }
      });

      const idleBtn = document.createElement("button");
      idleBtn.className = "btn btnSm";
      idleBtn.type = "button";
      idleBtn.textContent = "Idle";
      idleBtn.addEventListener("click", async () => {
        try {
          const got = await vrmaGet(item.name);
          if (!got) throw new Error("not found");
          await loadVrmaBytes(new Uint8Array(got.bytes));
          sendPetControl({ type: "PET_CONTROL", ts: Date.now(), action: "ASSIGN_VRMA_SLOT_FROM_LAST", slot: "idle" } as any);
          showToast(`已设为 Idle：${item.name}`, { timeoutMs: 2000 });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          showToast(`设置失败：${msg}`, { timeoutMs: 5200 });
        }
      });

      const walkBtn = document.createElement("button");
      walkBtn.className = "btn btnSm";
      walkBtn.type = "button";
      walkBtn.textContent = "Walk";
      walkBtn.addEventListener("click", async () => {
        try {
          const got = await vrmaGet(item.name);
          if (!got) throw new Error("not found");
          await loadVrmaBytes(new Uint8Array(got.bytes));
          sendPetControl({ type: "PET_CONTROL", ts: Date.now(), action: "ASSIGN_VRMA_SLOT_FROM_LAST", slot: "walk" } as any);
          showToast(`已设为 Walk：${item.name}`, { timeoutMs: 2000 });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          showToast(`设置失败：${msg}`, { timeoutMs: 5200 });
        }
      });

      const renameBtn = document.createElement("button");
      renameBtn.className = "btn btnSm";
      renameBtn.type = "button";
      renameBtn.textContent = "重命名";
      renameBtn.addEventListener("click", async () => {
        const next = normalizeVrmaName(window.prompt("新的名字：", item.name) ?? "");
        if (!next) return;
        if (next === item.name) return;
        try {
          const exists = await vrmaGet(next);
          if (exists) {
            const ok = window.confirm(`动作库已存在「${next}」。要覆盖吗？`);
            if (!ok) return;
          }
          const got = await vrmaGet(item.name);
          if (!got) throw new Error("not found");
          await vrmaPut({ ...got, name: next, updatedAt: Date.now() });
          await vrmaDelete(item.name);
          await refreshVrmaLibrary();
          showToast(`已重命名：${item.name} → ${next}`, { timeoutMs: 2000 });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          showToast(`重命名失败：${msg}`, { timeoutMs: 5200 });
        }
      });

      const delBtn = document.createElement("button");
      delBtn.className = "btn btnSm btnDanger";
      delBtn.type = "button";
      delBtn.textContent = "删除";
      delBtn.addEventListener("click", async () => {
        const ok = window.confirm(`删除动作「${item.name}」？`);
        if (!ok) return;
        try {
          await vrmaDelete(item.name);
          await refreshVrmaLibrary();
          showToast("已删除", { timeoutMs: 1400 });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          showToast(`删除失败：${msg}`, { timeoutMs: 5200 });
        }
      });

      actions.append(playBtn, idleBtn, walkBtn, renameBtn, delBtn);
      row.append(left, actions);
      frag.appendChild(row);
    }

    vrmaLibListEl.appendChild(frag);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showToast(`动作库读取失败：${msg}`, { timeoutMs: 5200 });
  }
}

function boot() {
  // --- View navigation -------------------------------------------------------
  settingsBtn.addEventListener("click", () => {
    setView("settings");
    void loadLlmConfigIntoForm();
    void refreshLlmRuntime();
    void refreshMemorySection();
  });
  backBtn.addEventListener("click", () => setView("chat"));

  // Accordion-style settings cards: open one, close the rest.
  // This keeps settings from being "dumped" on users all at once.
  const settingsCards = Array.from(document.querySelectorAll('details[data-accordion="settings"]')).filter(
    (d): d is HTMLDetailsElement => d instanceof HTMLDetailsElement
  );
  for (const card of settingsCards) {
    card.addEventListener("toggle", () => {
      if (!card.open) return;
      for (const other of settingsCards) {
        if (other === card) continue;
        other.open = false;
      }
    });
  }

  // --- Motion / VRMA settings (in Settings view) -----------------------------
  updateMotionFormFromState();
  applyMotionToPet();
  void refreshVrmaLibrary();

  // --- Long-term memory (in Settings view) ----------------------------------
  memoryNoteAddEl.addEventListener("click", () => void addMemoryNoteFromInput());
  memoryNoteInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void addMemoryNoteFromInput();
    }
  });
  refreshMemoryNotesEl.addEventListener("click", () => void refreshMemorySection());

  clearChatHistoryEl.addEventListener("click", () => {
    void (async () => {
      const ok = window.confirm("清空聊天记录？这会同时清空本窗口的聊天历史（不可恢复）。");
      if (!ok) return;
      const api = getApi();
      if (!api || typeof api.clearChatHistory !== "function") {
        showToast("preload API 缺失：无法清空聊天记录", { timeoutMs: 4200 });
        return;
      }
      try {
        const res = await api.clearChatHistory();
        if (!res?.ok) {
          showToast("清空失败（可能未启用本地 SQLite）", { timeoutMs: 5200 });
          return;
        }
        showToast("已清空聊天记录", { timeoutMs: 1600 });
        void refreshMemorySection();

        // Extra robustness: pull log once so UI updates even if a broadcast was missed.
        try {
          if (typeof api.getChatLog === "function") {
            const sync = await api.getChatLog();
            if (sync && sync.type === "CHAT_LOG_SYNC") {
              renderAll(Array.isArray((sync as any).entries) ? (sync as any).entries : []);
            }
          }
        } catch {}
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showToast(`清空失败：${message}`, { timeoutMs: 5200 });
      }
    })();
  });

  clearMemoryNotesEl.addEventListener("click", () => {
    void (async () => {
      const ok = window.confirm("清空长期记忆？（只清空记忆条目，不影响聊天记录）");
      if (!ok) return;
      const api = getApi();
      if (!api || typeof api.clearMemoryNotes !== "function") {
        showToast("preload API 缺失：无法清空记忆", { timeoutMs: 4200 });
        return;
      }
      try {
        const res = await api.clearMemoryNotes();
        if (!res?.ok) {
          showToast("清空失败（可能未启用本地 SQLite）", { timeoutMs: 5200 });
          return;
        }
        showToast("已清空记忆", { timeoutMs: 1600 });
        void refreshMemorySection();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showToast(`清空失败：${message}`, { timeoutMs: 5200 });
      }
    })();
  });

  vrmaSaveNameEl.addEventListener("input", () => {
    const name = normalizeVrmaName(vrmaSaveNameEl.value);
    saveVrmaEl.disabled = !lastVrmaBytes || !name;
  });

  pickVrmaBtn.addEventListener("click", () => {
    void (async () => {
      try {
        const picked = await pickFileViaFileInput(".vrma");
        if (!picked) return;

        lastVrmaBytes = picked.bytes;
        lastVrmaFileName = picked.fileName || "动作.vrma";

        setVrmaStatusText(`最近：${lastVrmaFileName}（加载中…）`);

        // Suggest a library name, but don't clobber user edits.
        if (!normalizeVrmaName(vrmaSaveNameEl.value)) {
          vrmaSaveNameEl.value = normalizeVrmaName(stripExtension(lastVrmaFileName));
        }
        saveVrmaEl.disabled = !normalizeVrmaName(vrmaSaveNameEl.value);

        await loadVrmaBytes(lastVrmaBytes);
        setVrmaStatusText(`最近：${lastVrmaFileName}（已加载）`);
        showToast("已加载 VRMA（可设为 Idle/Walk）", { timeoutMs: 1800 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setVrmaStatusText(`最近：${lastVrmaFileName || "—"}（失败）`);
        showToast(`加载 VRMA 失败：${msg}`, { timeoutMs: 5200 });
      }
    })();
  });

  stopVrmaBtn.addEventListener("click", () => {
    sendPetControl({ type: "PET_CONTROL", ts: Date.now(), action: "CLEAR_VRMA_ACTION" } as any);
    showToast("已停止动作", { timeoutMs: 1400 });
  });

  setIdleFromLastBtn.addEventListener("click", () => {
    sendPetControl({ type: "PET_CONTROL", ts: Date.now(), action: "ASSIGN_VRMA_SLOT_FROM_LAST", slot: "idle" } as any);
    showToast("已设为 Idle（自动切换）", { timeoutMs: 1600 });
  });
  setWalkFromLastBtn.addEventListener("click", () => {
    sendPetControl({ type: "PET_CONTROL", ts: Date.now(), action: "ASSIGN_VRMA_SLOT_FROM_LAST", slot: "walk" } as any);
    showToast("已设为 Walk（自动切换）", { timeoutMs: 1600 });
  });

  vrmaSpeedEl.addEventListener("input", () => {
    motionUi.vrma.speed = clamp(Number(vrmaSpeedEl.value), 0, 2);
    vrmaSpeedValueEl.textContent = `${fmtNum(motionUi.vrma.speed, 2)}x`;
    saveMotionUiSettings(motionUi);
    queueVrmaConfig({ speed: motionUi.vrma.speed });
  });

  vrmaPausedEl.addEventListener("change", () => {
    motionUi.vrma.paused = Boolean(vrmaPausedEl.checked);
    saveMotionUiSettings(motionUi);
    queueVrmaConfig({ paused: motionUi.vrma.paused });
  });

  saveVrmaEl.addEventListener("click", () => {
    void (async () => {
      const bytes = lastVrmaBytes;
      if (!bytes || !bytes.byteLength) {
        showToast("请先上传一个 VRMA", { timeoutMs: 2200 });
        return;
      }

      const rawName = normalizeVrmaName(vrmaSaveNameEl.value);
      if (!rawName) {
        vrmaSaveNameEl.focus();
        showToast("请输入动作名字", { timeoutMs: 1800 });
        return;
      }

      try {
        const existing = await vrmaGet(rawName);
        if (existing) {
          const ok = window.confirm(`动作库已存在「${rawName}」。要覆盖吗？`);
          if (!ok) return;
        }

        const now = Date.now();
        await vrmaPut({
          name: rawName,
          bytes: bytesToArrayBuffer(bytes),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now
        });
        await refreshVrmaLibrary();
        showToast(`已保存到动作库：${rawName}`, { timeoutMs: 2000 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showToast(`保存失败：${msg}`, { timeoutMs: 5200 });
      }
    })();
  });

  refreshVrmaLibEl.addEventListener("click", () => void refreshVrmaLibrary());

  idleEnabledEl.addEventListener("change", () => {
    motionUi.idle.enabled = Boolean(idleEnabledEl.checked);
    saveMotionUiSettings(motionUi);
    queueIdleConfig({ enabled: motionUi.idle.enabled });
  });
  idleStrengthEl.addEventListener("input", () => {
    motionUi.idle.strength = clamp(Number(idleStrengthEl.value), 0, 1);
    idleStrengthValueEl.textContent = fmtNum(motionUi.idle.strength, 2);
    saveMotionUiSettings(motionUi);
    queueIdleConfig({ strength: motionUi.idle.strength });
  });
  idleSpeedEl.addEventListener("input", () => {
    motionUi.idle.speed = clamp(Number(idleSpeedEl.value), 0.2, 2);
    idleSpeedValueEl.textContent = `${fmtNum(motionUi.idle.speed, 2)}x`;
    saveMotionUiSettings(motionUi);
    queueIdleConfig({ speed: motionUi.idle.speed });
  });

  walkEnabledEl.addEventListener("change", () => {
    motionUi.walk.enabled = Boolean(walkEnabledEl.checked);
    saveMotionUiSettings(motionUi);
    queueWalkConfig({ enabled: motionUi.walk.enabled });
  });
  walkSpeedEl.addEventListener("input", () => {
    motionUi.walk.speed = clamp(Number(walkSpeedEl.value), 0.2, 2);
    walkSpeedValueEl.textContent = `${fmtNum(motionUi.walk.speed, 2)}x`;
    saveMotionUiSettings(motionUi);
    queueWalkConfig({ speed: motionUi.walk.speed });
  });
  walkStrideEl.addEventListener("input", () => {
    motionUi.walk.stride = clamp(Number(walkStrideEl.value), 0, 1);
    walkStrideValueEl.textContent = fmtNum(motionUi.walk.stride, 2);
    saveMotionUiSettings(motionUi);
    queueWalkConfig({ stride: motionUi.walk.stride });
  });

  providerEl.addEventListener("change", () => updateProviderPanels());
  updateProviderPanels();

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

  void refreshLlmRuntime();
  void refreshMemorySection();

  const api = getApi();
  try {
    api?.sendUserInteraction?.({ type: "USER_INTERACTION", ts: Date.now(), event: "OPEN_CHAT" });
  } catch {}
  window.addEventListener("beforeunload", () => {
    try {
      getApi()?.sendUserInteraction?.({ type: "USER_INTERACTION", ts: Date.now(), event: "CLOSE_CHAT" });
    } catch {}
  });

  // Always render something immediately so the timeline is never a blank void.
  renderEmpty();
  // Pull current log once at startup (avoids any race with did-finish-load).
  void (async () => {
    try {
      if (api && typeof api.getChatLog === "function") {
        const sync = await api.getChatLog();
        if (sync && sync.type === "CHAT_LOG_SYNC") {
          renderAll(Array.isArray((sync as any).entries) ? (sync as any).entries : []);
        }
      }
    } catch {}
  })();

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
    showToast("preload API 缺失：无法同步聊天记录", { timeoutMs: 5200 });
  }

  // Pet status -> keep the Motion UI feeling grounded in reality.
  if (api && typeof api.onPetState === "function") {
    api.onPetState((s: PetStateMessage) => {
      const slots: any = (s as any)?.slots ?? null;
      if (!slots) return;

      const idleMark = slots.hasIdle ? "✓" : "-";
      const walkMark = slots.hasWalk ? "✓" : "-";
      const actMark = slots.hasAction ? "✓" : "-";
      slotStatusEl.textContent = `idle ${idleMark} · walk ${walkMark} · act ${actMark}`;

      stopVrmaBtn.disabled = !slots.hasAction;
      setIdleFromLastBtn.disabled = !slots.hasLastLoaded;
      setWalkFromLastBtn.disabled = !slots.hasLastLoaded;
    });
  }
}

try {
  boot();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  showToast(`启动失败：${message}`, { timeoutMs: 9000 });
  throw err;
}
