import { setupChat } from "./chat";

const historyEl = document.getElementById("history") as HTMLDivElement | null;
const inputEl = document.getElementById("input") as HTMLTextAreaElement | null;
const sendBtn = document.getElementById("send") as HTMLButtonElement | null;
const hintEl = document.getElementById("hint") as HTMLDivElement | null;
const statusEl = document.getElementById("status") as HTMLDivElement | null;
const modelTextEl = document.getElementById("modelText") as HTMLSpanElement | null;

if (!historyEl || !inputEl || !sendBtn) throw new Error("missing chat elements");

setupChat({ historyEl, inputEl, sendBtn, hintEl: hintEl ?? undefined, statusEl: statusEl ?? undefined });

void (async () => {
  const api: any = (window as any).stageDesktop;
  if (!modelTextEl) return;
  if (!api || typeof api.getAppInfo !== "function") {
    modelTextEl.textContent = "LLM: preload missing";
    return;
  }
  try {
    const info = await api.getAppInfo();
    modelTextEl.textContent = `LLM: ${String(info?.llmProvider ?? "unknown")}`;
  } catch {
    modelTextEl.textContent = "LLM: unknown";
  }
})();
