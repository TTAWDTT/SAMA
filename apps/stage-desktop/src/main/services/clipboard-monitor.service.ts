import { clipboard } from "electron";

function looksSensitiveText(s: string) {
  const t = String(s ?? "");
  if (!t) return false;
  if (/sk-[A-Za-z0-9]{10,}/.test(t)) return true;
  if (/AIza[0-9A-Za-z_-]{10,}/.test(t)) return true;
  if (/(api[_-]?key|password|密码|令牌|token)/i.test(t) && t.length > 20) return true;
  return false;
}

function sanitizeOneLine(s: string) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function clipExcerpt(s: string, maxChars: number) {
  const text = sanitizeOneLine(s);
  const arr = Array.from(text);
  if (arr.length <= maxChars) return text;
  return arr.slice(0, maxChars).join("").trim();
}

function extractFirstUrl(text: string): string | null {
  const s = String(text ?? "");
  const m = s.match(/https?:\/\/[^\s<>"'）)】\]]+/i);
  if (!m?.[0]) return null;
  return m[0];
}

function inferSiteFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host.includes("bilibili.com") || host.includes("b23.tv")) return "bilibili";
    if (host.includes("weibo.com") || host.includes("weibo.cn")) return "weibo";
    if (host.includes("xiaohongshu.com") || host.includes("xhslink.com")) return "xhs";
    if (host.includes("zhihu.com")) return "zhihu";
    // Generic "news" heuristics (best-effort)
    if (host.includes("news") || host.includes("cnn.com") || host.includes("nytimes.com") || host.includes("bbc.co")) return "news";
    return host || "unknown";
  } catch {
    return "unknown";
  }
}

function sanitizeUrlForModel(url: string) {
  const raw = String(url ?? "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    // Privacy: drop query/hash to avoid leaking tracking tokens.
    const safe = `${u.protocol}//${u.host}${u.pathname}`;
    return clipExcerpt(safe, 220);
  } catch {
    return clipExcerpt(raw, 220);
  }
}

function containsTimeWords(text: string): boolean {
  const s = String(text ?? "");
  if (!s.trim()) return false;

  // Quick URL skip: we handle links separately.
  if (/https?:\/\//i.test(s)) return false;

  const timeWords = [
    "明天",
    "后天",
    "下周",
    "下星期",
    "本周",
    "这周",
    "周末",
    "月底",
    "月初",
    "下个月",
    "今天",
    "今晚",
    "明早",
    "上午",
    "下午",
    "中午",
    "凌晨",
    "几点",
    "多少点",
    "周一",
    "周二",
    "周三",
    "周四",
    "周五",
    "周六",
    "周日",
    "星期",
    "礼拜"
  ];

  if (timeWords.some((w) => s.includes(w))) return true;
  if (/\b\d{1,2}[:：]\d{2}\b/.test(s)) return true;
  if (/\b\d{1,2}\s*(点|时)\b/.test(s)) return true;
  if (/\b(tomorrow|next week|friday|monday|tue|wed|thu|sat|sun)\b/i.test(s)) return true;
  return false;
}

export class ClipboardMonitorService {
  #timer: NodeJS.Timeout | null = null;
  #lastText = "";
  #enabled: boolean;
  #pollMs: number;
  #onSignal: (signal: any) => void;

  constructor(opts: { enabled?: boolean; pollMs?: number; onSignal: (signal: any) => void }) {
    this.#enabled = opts.enabled !== undefined ? Boolean(opts.enabled) : true;
    const ms = Math.floor(Number(opts.pollMs) || 0);
    this.#pollMs = ms > 0 ? Math.max(300, Math.min(4000, ms)) : 900;
    this.#onSignal = opts.onSignal;
  }

  start() {
    if (!this.#enabled) return;
    if (this.#timer) return;

    this.#timer = setInterval(() => {
      try {
        const raw = clipboard.readText() ?? "";
        const text = String(raw ?? "").trim();
        if (!text) return;
        if (text === this.#lastText) return;
        this.#lastText = text;

        // Privacy: skip likely secrets.
        if (looksSensitiveText(text)) return;

        const ts = Date.now();

        // Links first (news/social share links, etc.)
        const url = extractFirstUrl(text);
        if (url) {
          const safeUrl = sanitizeUrlForModel(url);
          this.#onSignal({ kind: "CLIPBOARD_LINK", ts, url: safeUrl, site: inferSiteFromUrl(url) });
          return;
        }

        // Time-ish content (agenda / scheduling)
        if (containsTimeWords(text)) {
          this.#onSignal({ kind: "CLIPBOARD_TIME", ts, excerpt: clipExcerpt(text, 80) });
          return;
        }
      } catch {}
    }, this.#pollMs);
  }

  dispose() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
