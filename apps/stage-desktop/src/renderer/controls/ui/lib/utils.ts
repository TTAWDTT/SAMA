export function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export function formatTime(ts: number) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function isNearBottom(el: HTMLElement, thresholdPx = 90) {
  const gap = el.scrollHeight - (el.scrollTop + el.clientHeight);
  return gap < thresholdPx;
}

export function scrollToBottom(el: HTMLElement, smooth = true) {
  if (smooth && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  } else {
    el.scrollTop = el.scrollHeight;
  }
}

export function safeString(v: unknown, fallback = "") {
  const s = typeof v === "string" ? v : String(v ?? "");
  return s || fallback;
}

export async function writeClipboard(api: any, text: string) {
  const t = String(text ?? "");
  if (!t) return false;

  // Priority 1: Electron API (via preload)
  if (api && typeof api.clipboardWrite === "function") {
    try {
      const ok = api.clipboardWrite(t);
      if (ok) return true;
    } catch {
      // fall through
    }
  }

  // Priority 2: Web API (navigator.clipboard)
  if (navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(t);
      return true;
    } catch {
      // fall through
    }
  }

  // Priority 3: Legacy execCommand (fallback)
  try {
    const textArea = document.createElement("textarea");
    textArea.value = t;
    textArea.style.position = "fixed";
    textArea.style.left = "-9999px";
    textArea.style.top = "0";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textArea);
    if (ok) return true;
  } catch {
    // fall through
  }

  return false;
}

