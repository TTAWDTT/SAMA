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

export function scrollToBottom(el: HTMLElement) {
  el.scrollTop = el.scrollHeight;
}

export function safeString(v: unknown, fallback = "") {
  const s = typeof v === "string" ? v : String(v ?? "");
  return s || fallback;
}

