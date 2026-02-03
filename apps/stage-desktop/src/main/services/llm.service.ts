import type { LLMConfig, LLMProviderName } from "../protocol/types";
import { buildBubbleSystemPrompt, buildChatSystemPrompt } from "../agent/prompts";
import { net } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type ChatImageAttachment = {
  dataUrl: string;
  name?: string;
};

export type ChatUserInput =
  | string
  | {
      text: string;
      images?: ChatImageAttachment[];
    };

export interface LLMProvider {
  name: string;
  generateBubble(ctx: { state: string; isNight: boolean; mood: number }): Promise<string>;
  chatReply(
    ctx: {
      state: string;
      isNight: boolean;
      mood: number;
      /** Durable memory (short, human-readable). */
      memory?: string;
      /** Rolling short-term summary for continuity (best-practice working memory). */
      summary?: string;
      /** Optional injected skill instructions (local-only). */
      skills?: string;
      /** Optional injected tool docs/call format (local-only). */
      tools?: string;
      history: { role: "user" | "assistant"; content: string }[];
    },
    userMsg: ChatUserInput
  ): Promise<string>;
  /**
   * Extract durable memory notes from a single turn.
   * Implementations should be conservative: only return stable facts/preferences.
   */
  extractMemoryNotes?: (
    ctx: {
      state: string;
      isNight: boolean;
      mood: number;
      memory?: string;
      summary?: string;
      history: { role: "user" | "assistant"; content: string }[];
    },
    turn: { user: string; assistant: string }
  ) => Promise<
    {
      kind: "preference" | "profile" | "project" | "note";
      content?: string;
      key?: string;
      value?: string;
    }[]
  >;

  // Optional: update the rolling short-term summary (kept separate from durable notes).
  summarizeConversation?: (opts: {
    currentSummary: string;
    newMessages: { role: "user" | "assistant"; content: string }[];
  }) => Promise<string>;

  // Optional: re-rank retrieved long-term memory items by relevance to the current user query.
  rerankMemory?: (opts: {
    query: string;
    limit: number;
    facts: { id: number; kind: string; key: string; value: string }[];
    notes: { id: number; kind: string; content: string }[];
  }) => Promise<{ factIds: number[]; noteIds: number[] }>;
}

type OpenAICompatibleOpts = {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
};

function normalizeProviderName(raw: unknown): LLMProviderName | null {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!s) return null;
  if (s === "auto") return "auto";
  if (s === "off" || s === "none" || s === "disable" || s === "disabled") return "off";
  if (s === "openai" || s === "chatgpt") return "openai";
  if (s === "deepseek") return "deepseek";
  if (s === "aistudio" || s === "ai-studio" || s === "gemini") return "aistudio";
  return null;
}

function nonEmptyString(raw: unknown) {
  if (typeof raw !== "string") return "";
  const s = raw.trim();
  return s ? s : "";
}

function truncateByCodepoints(s: string, max: number) {
  const arr = Array.from(s.trim());
  if (arr.length <= max) return arr.join("");
  return arr.slice(0, max).join("");
}

function smartTruncatePreferBoundary(raw: string, max: number) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const arr = Array.from(s);
  if (arr.length <= max) return s;

  const boundaryChars = new Set(["。", "！", "？", ".", "!", "?", "；", ";", "，", ",", "\n", "）", ")", "】", "]"]);
  const tailLookback = Math.min(36, Math.max(12, Math.floor(max * 0.25)));
  const start = Math.max(0, max - tailLookback);

  let cutAt = -1;
  for (let i = max - 1; i >= start; i--) {
    const ch = arr[i] ?? "";
    if (boundaryChars.has(ch)) {
      cutAt = i + 1; // keep boundary char
      break;
    }
  }

  const out = cutAt > 0 ? arr.slice(0, cutAt).join("") : arr.slice(0, max).join("");
  return out.trim();
}

function sanitizeOneLine(s: string) {
  return s.replace(/\s+/g, " ").replace(/(^[“”"']+|[“”"']+$)/g, "").trim();
}

function sanitizeChatText(raw: string) {
  // Keep markdown/newlines for the chat UI, but normalize line endings and excessive blank lines.
  return String(raw ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function normalizeChatUserInput(input: ChatUserInput): { text: string; images: ChatImageAttachment[] } {
  if (typeof input === "string") return { text: input, images: [] };
  const text = String((input as any)?.text ?? "");
  const imagesRaw = (input as any)?.images;
  const images = Array.isArray(imagesRaw)
    ? imagesRaw
        .map((img: any) => {
          const dataUrl = String(img?.dataUrl ?? "");
          const name = img?.name ? String(img.name) : undefined;
          return dataUrl ? { dataUrl, name } : null;
        })
        .filter(Boolean)
    : [];
  return { text, images: images as ChatImageAttachment[] };
}

function parseImageDataUrl(dataUrl: string): { mimeType: string; dataBase64: string } | null {
  const s = String(dataUrl ?? "");
  const m = /^data:([^;]+);base64,(.+)$/i.exec(s);
  if (!m) return null;
  const mimeType = String(m[1] ?? "").trim();
  const dataBase64 = String(m[2] ?? "").trim();
  if (!mimeType.startsWith("image/")) return null;
  if (!dataBase64) return null;
  return { mimeType, dataBase64 };
}

function stripNightNagPrefix(raw: string) {
  const s = String(raw ?? "").trimStart();
  if (!s) return "";

  // Some models pick up a "night reminder" style and keep repeating it.
  // Strip a leading "夜里说话..." clause so it doesn't infect future history.
  const m = s.match(/^夜里说话[^。\n]{0,18}?(?:安静点|更轻点|小声点|轻点|安静些|小点)[。!！…]*\s*/);
  if (!m) return s;
  const rest = s.slice(m[0].length).trimStart();
  return rest || s;
}

function parseMemoryExtractorJson(raw: string) {
  const text = String(raw ?? "").trim();
  if (!text) return [];

  // The extractor prompt requests strict JSON, but be defensive:
  // - strip markdown fences
  // - accept JSON object wrappers like {"items":[...]} / {"memories":[...]}
  // - tolerate a missing trailing ']' by attempting to close the array
  const withoutFences = text.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const start = withoutFences.indexOf("[");
  const end = withoutFences.lastIndexOf("]");
  const slice = start >= 0 && end > start ? withoutFences.slice(start, end + 1) : withoutFences;

  try {
    const parsed: any = JSON.parse(slice);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") {
      const wrapped = (parsed as any).items ?? (parsed as any).memories ?? (parsed as any).memory;
      if (Array.isArray(wrapped)) return wrapped;
    }
    return [];
  } catch {
    // Minimal repair: if we found an array start but no matching closing bracket, attempt to close it.
    if (start >= 0 && end < start) {
      const attempt = withoutFences.slice(start).trimEnd() + "]";
      try {
        const parsed2: any = JSON.parse(attempt);
        if (Array.isArray(parsed2)) return parsed2;
      } catch {}
    }
    return [];
  }
}

function parseJsonObjectFromText(raw: string): any | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  // Try to slice the first JSON object; be defensive against markdown fences.
  const withoutFences = text.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const start = withoutFences.indexOf("{");
  const end = withoutFences.lastIndexOf("}");
  const slice = start >= 0 && end > start ? withoutFences.slice(start, end + 1) : withoutFences;
  try {
    const parsed = JSON.parse(slice);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

type ConversationSummaryV1 = {
  version: 1;
  profile: string[];
  preferences: string[];
  goals: string[];
  decisions: string[];
  constraints: string[];
  todos: string[];
  context: string[];
};

function normalizeSummaryList(v: unknown, maxItems: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v.slice(0, maxItems)) {
    const s = String(item ?? "").trim();
    if (!s) continue;
    out.push(truncateByCodepoints(s, 160));
  }
  return out;
}

function parseConversationSummaryV1(raw: string): ConversationSummaryV1 | null {
  const obj = parseJsonObjectFromText(raw);
  if (!obj) return null;
  const version = Number((obj as any).version ?? 1);
  if (version !== 1) return null;

  const summary: ConversationSummaryV1 = {
    version: 1,
    profile: normalizeSummaryList((obj as any).profile, 8),
    preferences: normalizeSummaryList((obj as any).preferences, 10),
    goals: normalizeSummaryList((obj as any).goals, 8),
    decisions: normalizeSummaryList((obj as any).decisions, 10),
    constraints: normalizeSummaryList((obj as any).constraints, 10),
    todos: normalizeSummaryList((obj as any).todos, 10),
    context: normalizeSummaryList((obj as any).context, 10)
  };

  const nonEmpty =
    summary.profile.length ||
    summary.preferences.length ||
    summary.goals.length ||
    summary.decisions.length ||
    summary.constraints.length ||
    summary.todos.length ||
    summary.context.length;
  return nonEmpty ? summary : { ...summary, context: [] };
}

function renderConversationSummary(summary: ConversationSummaryV1): string {
  const sections: { title: string; items: string[] }[] = [
    { title: "用户画像", items: summary.profile },
    { title: "偏好", items: summary.preferences },
    { title: "目标", items: summary.goals },
    { title: "已决定事项", items: summary.decisions },
    { title: "约束", items: summary.constraints },
    { title: "待办", items: summary.todos },
    { title: "上下文", items: summary.context }
  ];

  const lines: string[] = [];
  for (const s of sections) {
    if (!s.items.length) continue;
    lines.push(`【${s.title}】`);
    for (const it of s.items) lines.push(`- ${it}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

function parseRerankResult(raw: string): { factIds: number[]; noteIds: number[] } | null {
  const obj = parseJsonObjectFromText(raw);
  if (!obj) return null;
  const facts = Array.isArray((obj as any).facts) ? (obj as any).facts : (obj as any).factIds;
  const notes = Array.isArray((obj as any).notes) ? (obj as any).notes : (obj as any).noteIds;
  const toIds = (v: any) =>
    (Array.isArray(v) ? v : [])
      .map((x) => Math.floor(Number(x) || 0))
      .filter((n) => Number.isFinite(n) && n > 0)
      .slice(0, 40);
  const factIds = toIds(facts);
  const noteIds = toIds(notes);
  if (!factIds.length && !noteIds.length) return null;
  return { factIds, noteIds };
}

function hashStringCodepoints(s: string) {
  // Simple deterministic hash for variant selection (FNV-like).
  let h = 2166136261;
  for (const ch of Array.from(String(s ?? ""))) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickVariant(options: string[], seed: number, avoid?: string) {
  if (options.length === 0) return "";
  if (options.length === 1) return options[0] ?? "";

  const idx = seed % options.length;
  const first = options[idx] ?? options[0] ?? "";
  if (!avoid || sanitizeOneLine(first) !== sanitizeOneLine(avoid)) return first;

  // Pick the next option deterministically if we need to avoid repeating.
  for (let i = 1; i < options.length; i++) {
    const next = options[(idx + i) % options.length] ?? "";
    if (sanitizeOneLine(next) !== sanitizeOneLine(avoid)) return next;
  }
  return first;
}

function isLowValueAckReply(s: string) {
  const t = sanitizeOneLine(String(s ?? ""));
  if (!t) return true;
  const compact = t.replace(/\s+/g, "");

  // Very short acknowledgements look broken in a bubble-only UX.
  if (compact.length <= 2 && /^(嗯|哦|哈|好|行|在)$/.test(compact)) return true;

  // Common "I heard you" style replies that feel stuck.
  if (
    /^(我听到了|我听见了|我在听|我在听着|我听着呢|收到|知道了|了解了|明白了)([。!！…]*)$/.test(compact)
  ) {
    return true;
  }

  // Generic filler that doesn't react to the message at all.
  if (/^(嗯…|嗯\\.\\.\\.|嗯\\.\\.\\.)([。!！…]*)$/.test(t)) return true;
  return false;
}

/**
 * Use Electron's net.fetch which respects system proxy settings.
 * Falls back to Node.js fetch if net is not available (e.g., during testing).
 */
async function electronFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  // Electron's net module respects system proxy settings
  // This is crucial for users in China who might use a proxy to access DeepSeek API
  try {
    // net.fetch is available in Electron >= 28
    if (typeof net?.fetch === "function") {
      return await net.fetch(input.toString(), init as any);
    }
  } catch (e) {
    console.warn("[llm-api] net.fetch not available, falling back to global fetch");
  }
  // Fallback to Node.js fetch
  return fetch(input, init);
}

async function fetchWithTimeout(input: string | URL, init: RequestInit, timeoutMs: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Math.max(1, timeoutMs));
  try {
    return await electronFetch(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchWithRetry(
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
  maxRetries: number = 2
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetchWithTimeout(input, init, timeoutMs);
      return res;
    } catch (err: any) {
      lastError = err;
      // Check for DNS/network errors - these should be retried
      const errMsg = String(err?.message ?? "");
      const errCause = String(err?.cause?.message ?? err?.cause ?? "");
      const isNetworkError =
        errMsg.includes("ENOTFOUND") ||
        errMsg.includes("ECONNREFUSED") ||
        errMsg.includes("ETIMEDOUT") ||
        errCause.includes("ENOTFOUND") ||
        errCause.includes("getaddrinfo");
      const isAbort = err?.name === "AbortError" || errMsg.includes("abort");

      // Retry on timeout/abort or network errors
      if ((!isAbort && !isNetworkError) || attempt >= maxRetries) {
        // Add helpful error context
        if (isNetworkError) {
          console.error(`[llm-api] Network error (DNS/connection failed). Check if you can access api.deepseek.com in browser. If using a proxy, it may not be configured for this app.`);
        }
        throw err;
      }
      console.warn(`[llm-api] retry attempt ${attempt + 1}/${maxRetries} after ${isNetworkError ? "network error" : "timeout"}`);
      // Small delay before retry
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastError ?? new Error("fetch failed");
}

async function openAICompatibleChat(
  opts: OpenAICompatibleOpts,
  messages: any[],
  maxTokens: number,
  timeoutMs: number,
  temperature?: number
) {
  const url = `${opts.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };
  const hasApiKey = Boolean(opts.apiKey);
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

  console.log(`[llm-api] ${opts.name} request to ${url}, model=${opts.model}, hasKey=${hasApiKey}, timeout=${timeoutMs}ms`);

  const startTime = Date.now();
  const temp =
    typeof temperature === "number" && Number.isFinite(temperature) ? Math.max(0, Math.min(2, temperature)) : 0.7;
  let res: Response;
  try {
    res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          ...headers
        },
        body: JSON.stringify({
          model: opts.model,
          messages,
          temperature: temp,
          max_tokens: maxTokens
        })
      },
      timeoutMs,
      1 // 1 retry for chat requests
    );
  } catch (fetchErr: any) {
    const elapsed = Date.now() - startTime;
    console.error(`[llm-api] ${opts.name} fetch failed after ${elapsed}ms:`, fetchErr?.message ?? fetchErr);
    throw fetchErr;
  }

  const elapsed = Date.now() - startTime;
  console.log(`[llm-api] ${opts.name} response status=${res.status} in ${elapsed}ms`);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`[llm-api] ${opts.name} HTTP error: ${res.status}, body: ${text.slice(0, 500)}`);
    throw new Error(`[${opts.name}] HTTP ${res.status}: ${text}`);
  }

  const data: any = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    console.error(`[llm-api] ${opts.name} unexpected response:`, JSON.stringify(data).slice(0, 500));
    throw new Error(`[${opts.name}] unexpected response shape`);
  }
  return content;
}

type ModelLimit = { context: number; output: number };
let CACHED_APIS_JSON: any | null = null;

function tryLoadApisJson(): any | null {
  if (CACHED_APIS_JSON) return CACHED_APIS_JSON;
  const env = String(process.env.SAMA_APIS_JSON ?? "").trim();
  const candidates = [env, resolve(process.cwd(), "APIs.json")].filter(Boolean);

  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const raw = readFileSync(p, "utf-8");
      CACHED_APIS_JSON = JSON.parse(raw);
      return CACHED_APIS_JSON;
    } catch {}
  }
  return null;
}

function normalizeProviderForApis(provider: string): string {
  const p = String(provider ?? "").trim().toLowerCase();
  if (p === "aistudio") return "google";
  return p;
}

function getModelLimitFromApis(provider: string, model: string): ModelLimit | null {
  const data = tryLoadApisJson();
  if (!data || typeof data !== "object") return null;
  const providerKey = normalizeProviderForApis(provider);

  const p = (data as any)?.[providerKey];
  const models = p && typeof p === "object" ? (p as any).models : null;
  const m = models && typeof models === "object" ? (models as any)[String(model ?? "")] : null;
  const lim = m && typeof m === "object" ? (m as any).limit : null;
  const context = Math.floor(Number(lim?.context ?? 0) || 0);
  const output = Math.floor(Number(lim?.output ?? 0) || 0);
  if (context > 0 && output > 0) return { context, output };
  return null;
}

function estimateTokens(text: string): number {
  const s = String(text ?? "");
  if (!s) return 0;

  // Rough mixed-language estimate with a small safety buffer:
  // - CJK chars are often ~1 token.
  // - Other chars average ~4 chars/token.
  let cjk = 0;
  let other = 0;

  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i) ?? 0;
    if (cp > 0xffff) i++; // surrogate pair

    const isCjk =
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
      (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
      (cp >= 0x3000 && cp <= 0x303f) || // CJK Symbols and Punctuation
      (cp >= 0xff00 && cp <= 0xffef); // Halfwidth/Fullwidth Forms

    if (isCjk) cjk++;
    else other++;
  }

  const base = cjk + other / 4;
  return Math.max(1, Math.ceil(base * 1.15));
}

function truncateToTokenBudget(text: string, maxTokens: number): string {
  const s = String(text ?? "");
  if (!s) return "";
  const budget = Math.max(0, Math.floor(maxTokens) || 0);
  if (!budget) return "";
  if (estimateTokens(s) <= budget) return s;

  // Scale by ratio, then refine via boundary-aware truncation.
  const ratio = Math.max(0.05, Math.min(0.98, budget / Math.max(1, estimateTokens(s))));
  const approxChars = Math.max(40, Math.floor(Array.from(s).length * ratio));
  return smartTruncatePreferBoundary(s, approxChars);
}

type OpenAIChatPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };
type OpenAIContent = string | OpenAIChatPart[];

function openAIContentToText(content: OpenAIContent): string {
  if (typeof content === "string") return content;
  const parts = Array.isArray(content) ? content : [];
  return parts.map((p) => (p && (p as any).type === "text" ? String((p as any).text ?? "") : "")).join("");
}

function replaceTextInOpenAIContent(content: OpenAIContent, nextText: string): OpenAIContent {
  if (typeof content === "string") return nextText;
  const parts = Array.isArray(content) ? [...content] : [];
  const idx = parts.findIndex((p) => p && (p as any).type === "text");
  if (idx >= 0) {
    const prev = parts[idx] as any;
    parts[idx] = { type: "text", text: nextText } as any;
    // Preserve any additional keys on the previous object just in case.
    if (prev && typeof prev === "object") parts[idx] = { ...(prev as any), type: "text", text: nextText } as any;
    return parts;
  }
  return [{ type: "text", text: nextText }, ...parts];
}

function buildOpenAIUserContent(text: string, images: ChatImageAttachment[]): OpenAIContent {
  const imgs = Array.isArray(images) ? images : [];
  if (!imgs.length) return String(text ?? "");

  const safeText = String(text ?? "").trim() || "（用户发送了图片）";
  const parts: OpenAIChatPart[] = [{ type: "text", text: safeText }];
  for (const img of imgs) {
    const url = String((img as any)?.dataUrl ?? "");
    if (!url) continue;
    parts.push({ type: "image_url", image_url: { url } });
  }
  return parts;
}

function buildOpenAIMessagesWithBudget(opts: {
  system: string;
  history: { role: "user" | "assistant"; content: string }[];
  user: OpenAIContent;
  inputBudgetTokens?: number;
}) {
  const systemRaw = String(opts.system ?? "");
  const history = Array.isArray(opts.history) ? opts.history : [];
  let userContent: OpenAIContent = opts.user ?? "";
  let userRaw = openAIContentToText(userContent);

  const budget = Math.floor(Number(opts.inputBudgetTokens ?? 0) || 0);
  if (!budget) {
    return [
      { role: "system", content: systemRaw },
      ...history.slice(-20),
      { role: "user", content: userContent }
    ];
  }

  const overhead = 12; // small per-request overhead buffer

  let systemText = systemRaw;
  let userText = userRaw;

  // Ensure system + user fit first (priority).
  let sysTokens = estimateTokens(systemText) + 4;
  let userTokens = estimateTokens(userText) + 4;

  if (sysTokens + userTokens + overhead > budget) {
    userText = truncateToTokenBudget(userText, Math.max(32, budget - sysTokens - overhead));
    userContent = replaceTextInOpenAIContent(userContent, userText);
    userTokens = estimateTokens(userText) + 4;
  }

  if (sysTokens + userTokens + overhead > budget) {
    systemText = truncateToTokenBudget(systemText, Math.max(64, budget - userTokens - overhead));
    sysTokens = estimateTokens(systemText) + 4;
  }

  let remaining = Math.max(0, budget - sysTokens - userTokens - overhead);
  // Keep some headroom for formatting and minor tokenization differences.
  remaining = Math.max(0, remaining - 64);

  const pickedHistory: { role: "user" | "assistant"; content: string }[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m) continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = String(m.content ?? "");
    const t = estimateTokens(content) + 4;
    if (t > remaining) continue;
    pickedHistory.push({ role, content });
    remaining -= t;
  }
  pickedHistory.reverse();

  return [
    { role: "system", content: systemText },
    ...pickedHistory,
    { role: "user", content: userContent }
  ];
}

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

async function geminiGenerateText(opts: {
  apiKey: string;
  model: string;
  systemInstruction: string;
  contents: GeminiContent[];
  maxOutputTokens: number;
  timeoutMs: number;
  temperature?: number;
}) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(opts.model)}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;

  const temperature =
    typeof opts.temperature === "number" && Number.isFinite(opts.temperature)
      ? Math.max(0, Math.min(2, opts.temperature))
      : 0.7;

  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: opts.systemInstruction }] },
        contents: opts.contents,
        generationConfig: {
          temperature,
          maxOutputTokens: opts.maxOutputTokens
        }
      })
    },
    opts.timeoutMs
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[aistudio/gemini] HTTP ${res.status}: ${text}`);
  }

  const data: any = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) throw new Error("[aistudio/gemini] unexpected response shape");
  const text = parts.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("");
  if (!text.trim()) throw new Error("[aistudio/gemini] empty response");
  return text;
}

function ruleBasedBubble(ctx: { state: string; isNight: boolean; mood: number }) {
  const nightHint = ctx.isNight ? "有点晚了…" : "";
  if (ctx.state === "SOCIAL_CHECK_LOOP") return `${nightHint}要不要歇一下？`.trim();
  if (ctx.state === "FRAGMENTED") return `${nightHint}好像有点忙呢…`.trim();
  if (ctx.state === "FOCUS") return `${nightHint}`.trim() || "我在旁边哦";
  if (ctx.mood < 0.35) return `${nightHint}我不太确定…`.trim();
  return `${nightHint}需要我陪陪吗？`.trim();
}

function ruleBasedChatReply(ctx: { state: string; isNight: boolean; mood: number }, userMsg: string) {
  const trimmed = userMsg.trim();
  if (!trimmed) return "嗯？";
  const compact = trimmed.replace(/\s+/g, "");
  const seed = hashStringCodepoints(`${compact}|${ctx.state}|${ctx.isNight ? "n" : "d"}|${ctx.mood.toFixed(2)}`);

  // Special-cases for built-in diagnostics.
  if (compact.startsWith("测试气泡") || /^test$/i.test(compact)) return "气泡显示正常 ✅";

  // Short utterances are common in chat; avoid a single repetitive "我听到了".
  if (compact.length <= 4) {
    if (/^(hi|hello|hey)$/i.test(compact)) return "你好，我在。";
    if (/(你好|嗨|在吗|喂)/.test(compact)) return "我在呢。";
    if (/(谢谢|谢啦|thx|thanks)/i.test(compact)) return "不客气。";
    if (/[？?]$/.test(compact)) return "你想问哪一部分？";

    // Add a tiny bit of variety so it doesn't feel "stuck".
    return pickVariant(
      [
        "我在呢，你继续说。",
        "嗯，我听着。",
        "怎么啦？",
        "我在这儿。"
      ],
      seed
    );
  }
  if (ctx.state === "FOCUS") return "你先忙，我在这儿。";
  if (ctx.mood < 0.35) return "我可能理解得不够，但我愿意听。";
  return pickVariant(
    [
      "你想先从哪一点说起？",
      "你希望我怎么陪你？",
      "要不要先讲最困扰你的那一段？"
    ],
    seed
  );
}

class OpenAICompatibleProvider implements LLMProvider {
  name: string;
  #opts: OpenAICompatibleOpts;

  constructor(opts: OpenAICompatibleOpts) {
    this.name = opts.name;
    this.#opts = opts;
  }

  async generateBubble(ctx: { state: string; isNight: boolean; mood: number }) {
    const system = buildBubbleSystemPrompt();
    const maxOutputTokens = getModelLimitFromApis(this.name, this.#opts.model)?.output ?? 256;
    const raw = await openAICompatibleChat(
      this.#opts,
      [
        {
          role: "system",
          content: system
        },
        {
          role: "user",
          content: `状态=${ctx.state}, 夜间=${ctx.isNight ? "是" : "否"}, 情绪=${ctx.mood.toFixed(
            2
          )}。请给一句<=20个汉字的气泡内容。`
        }
      ],
      maxOutputTokens,
      12_000,
      0.7
    );
    return truncateByCodepoints(sanitizeOneLine(raw), 20);
  }

  async chatReply(
    ctx: {
      state: string;
      isNight: boolean;
      mood: number;
      memory?: string;
      summary?: string;
      skills?: string;
      tools?: string;
      history: { role: "user" | "assistant"; content: string }[];
    },
    userMsg: ChatUserInput
  ) {
    const { text, images } = normalizeChatUserInput(userMsg);
    const userContent = buildOpenAIUserContent(text, images);

    const system = buildChatSystemPrompt({
      memory: ctx?.memory,
      summary: ctx?.summary,
      skills: (ctx as any)?.skills,
      tools: (ctx as any)?.tools
    });

    const limit = getModelLimitFromApis(this.name, this.#opts.model);
    const maxOutputTokens = limit?.output ? Math.max(16, limit.output) : 4096;
    const inputBudgetTokens = limit?.context ? Math.max(512, limit.context - maxOutputTokens - 256) : 0;

    const messages = buildOpenAIMessagesWithBudget({
      system,
      history: (ctx.history ?? []).slice(-200),
      user: userContent,
      inputBudgetTokens: inputBudgetTokens || undefined
    });

    const raw = await openAICompatibleChat(this.#opts, messages, maxOutputTokens, 180_000);
    return sanitizeChatText(raw);
  }

  async summarizeConversation(opts: {
    currentSummary: string;
    newMessages: { role: "user" | "assistant"; content: string }[];
  }) {
    const maxOutputTokens = getModelLimitFromApis(this.name, this.#opts.model)?.output ?? 360;
    const system =
      "你是“对话摘要器（短期记忆/工作记忆）”。任务：维护一份用于继续聊天的结构化摘要。\n" +
      "输出要求：严格 JSON（不要 Markdown，不要解释）。\n" +
      "Schema：\n" +
      "{\n" +
      "  \"version\": 1,\n" +
      "  \"profile\": string[],\n" +
      "  \"preferences\": string[],\n" +
      "  \"goals\": string[],\n" +
      "  \"decisions\": string[],\n" +
      "  \"constraints\": string[],\n" +
      "  \"todos\": string[],\n" +
      "  \"context\": string[]\n" +
      "}\n" +
      "规则：\n" +
      "- 中文为主；每条尽量短（<= 25 汉字），像条目笔记。\n" +
      "- 只保留对后续有用的信息：用户目标/偏好/约束/已决定事项/正在做的任务。\n" +
      "- 不要加入道德说教、时间提醒（例如“夜里说话…”）。\n" +
      "- 不要包含敏感信息（密码/API Key/地址等）。\n" +
      "- 字段没有内容就输出空数组 []。\n" +
      "- 总体不要超过约 1200 汉字。";

    const current = String(opts?.currentSummary ?? "").trim();
    const lines = (opts?.newMessages ?? [])
      .slice(-24)
      .map((m) => `${m.role === "assistant" ? "A" : "U"}: ${sanitizeOneLine(truncateByCodepoints(String(m.content ?? ""), 240))}`)
      .join("\n");

    const prompt =
      `现有摘要：\n${current || "(空)"}\n\n` +
      `新增对话：\n${lines || "(无)"}\n\n` +
      "请输出更新后的 JSON：";

    const raw = await openAICompatibleChat(
      this.#opts,
      [
        { role: "system", content: system },
        { role: "user", content: prompt }
      ],
      maxOutputTokens,
      18_000,
      0.2
    );
    return sanitizeChatText(raw);
  }

  async extractMemoryNotes(
    ctx: {
      state: string;
      isNight: boolean;
      mood: number;
      memory?: string;
      summary?: string;
      history: { role: "user" | "assistant"; content: string }[];
    },
    turn: { user: string; assistant: string }
  ) {
    const maxOutputTokens = getModelLimitFromApis(this.name, this.#opts.model)?.output ?? 700;
    const memory = String(ctx?.memory ?? "").trim();
    const system =
      "你是“长期记忆提取器”。你会从对话中提取适合长期记住的稳定信息（偏好、名字、长期目标、项目背景）。\n" +
      "目标：提取对未来仍然有用且稳定的信息，写入长期记忆。\n" +
      "规则：\n" +
      "- 只提取用户明确表达、且未来仍可能成立的信息。\n" +
      "- 如果用户在本轮明确给出名字或希望的称呼（我叫X / 请叫我Y / 以后叫我Y / 你可以叫我Y），必须提取。\n" +
      "- 优先保留用户原话或贴近原话的表达，确保语义完整，不要截断成半句话。\n" +
      "- 不要提取一次性任务、临时计划、短期状态。\n" +
      "- 不要提取敏感信息（密码/API key/地址/身份证等）。\n" +
      "- 如不确定，输出空数组 []。\n" +
      "输出格式：严格 JSON 数组（不要 Markdown/代码块/解释），最多 4 条。每个元素二选一：\n" +
      "1) 可覆盖事实（推荐）：{\"kind\":\"profile|preference|project|note\",\"key\":\"...\",\"value\":\"...\"}\n" +
      "2) 普通笔记：{\"kind\":\"profile|preference|project|note\",\"content\":\"...\"}\n" +
      "可用 key 示例（尽量用这些，避免无限发明新 key）：\n" +
      "- user.name / user.language / user.response_style\n" +
      "- user.call_me\n" +
      "- project.name / project.repo / project.stack\n" +
      "- app.preference (如“不跑 build”)";

    const prompt =
      (memory ? `现有长期记忆（可能不完整）：\n${memory}\n\n` : "") +
      `用户：${String(turn?.user ?? "").trim()}\n` +
      `助手：${String(turn?.assistant ?? "").trim()}\n\n` +
      "请输出 JSON：";

    const raw = await openAICompatibleChat(
      this.#opts,
      [
        { role: "system", content: system },
        { role: "user", content: prompt }
      ],
      maxOutputTokens,
      20_000,
      0
    );
    return parseMemoryExtractorJson(raw);
  }

  async rerankMemory(opts: {
    query: string;
    limit: number;
    facts: { id: number; kind: string; key: string; value: string }[];
    notes: { id: number; kind: string; content: string }[];
  }) {
    const maxOutputTokens = getModelLimitFromApis(this.name, this.#opts.model)?.output ?? 400;
    const limit = Math.max(0, Math.min(40, Math.floor(Number(opts?.limit) || 0)));
    if (!limit) return { factIds: [], noteIds: [] };

    const query = sanitizeOneLine(String(opts?.query ?? ""));
    const facts = Array.isArray(opts?.facts) ? opts.facts : [];
    const notes = Array.isArray(opts?.notes) ? opts.notes : [];

    const system =
      "你是“长期记忆重排器”。任务：从候选记忆中选出最相关、最有用的条目，帮助回答用户当前问题。\n" +
      "输出要求：严格 JSON 对象，仅输出一次。\n" +
      "格式：{\"facts\":[id...],\"notes\":[id...]}\n" +
      "规则：\n" +
      `- 总数量（facts+notes）<= ${limit}。\n` +
      "- 只允许选择候选列表中出现的 id；不要发明 id。\n" +
      "- 优先选择与当前问题直接相关的事实/偏好/项目背景。\n" +
      "- 不要为了凑数选无关内容；不相关就留空数组。\n" +
      "- 不要输出解释、不要输出 Markdown。";

    const factLines = facts
      .slice(0, 40)
      .map((f) => {
        const id = Math.floor(Number((f as any).id) || 0);
        const kind = sanitizeOneLine(String((f as any).kind ?? "fact"));
        const key = sanitizeOneLine(String((f as any).key ?? ""));
        const value = sanitizeOneLine(truncateByCodepoints(String((f as any).value ?? ""), 120));
        return `- id=${id} kind=${kind} ${key}: ${value}`;
      })
      .join("\n");

    const noteLines = notes
      .slice(0, 80)
      .map((n) => {
        const id = Math.floor(Number((n as any).id) || 0);
        const kind = sanitizeOneLine(String((n as any).kind ?? "note"));
        const content = sanitizeOneLine(truncateByCodepoints(String((n as any).content ?? ""), 140));
        return `- id=${id} kind=${kind} ${content}`;
      })
      .join("\n");

    const prompt =
      `用户当前问题：\n${query || "(空)"}\n\n` +
      `候选 Facts：\n${factLines || "(无)"}\n\n` +
      `候选 Notes：\n${noteLines || "(无)"}\n\n` +
      "请输出 JSON：";

    const raw = await openAICompatibleChat(
      this.#opts,
      [
        { role: "system", content: system },
        { role: "user", content: prompt }
      ],
      maxOutputTokens,
      12_000,
      0.1
    );

    const parsed = parseRerankResult(raw);
    return parsed ?? { factIds: [], noteIds: [] };
  }

  isConfigured() {
    if (this.#opts.apiKey) return true;

    // Allow keyless local OpenAI-compatible endpoints (e.g. Ollama: http://localhost:11434/v1)
    // so users don't need to set a dummy API key.
    try {
      const url = new URL(this.#opts.baseUrl);
      const host = url.hostname.toLowerCase();
      const isLocalHost = host === "localhost" || host === "127.0.0.1" || host === "::1";
      const isHttp = url.protocol === "http:";
      return Boolean(isHttp && isLocalHost);
    } catch {
      return false;
    }
  }
}

class AIStudioProvider implements LLMProvider {
  name = "aistudio";
  #apiKey: string;
  #model: string;
  // Optional: if you have an OpenAI-compatible gateway, set AISTUDIO_BASE_URL
  #baseUrl: string;

  constructor(cfg: { apiKey: string; model: string; baseUrl: string }) {
    this.#apiKey = cfg.apiKey;
    this.#model = cfg.model;
    this.#baseUrl = cfg.baseUrl;
  }

  async generateBubble(ctx: { state: string; isNight: boolean; mood: number }) {
    const system = buildBubbleSystemPrompt();
    const prompt = `状态=${ctx.state}, 夜间=${ctx.isNight ? "是" : "否"}, 情绪=${ctx.mood.toFixed(
      2
    )}。请给一句<=20个汉字的气泡内容。`;

    const maxOutputTokens = getModelLimitFromApis(this.name, this.#model)?.output ?? 256;

    const raw = this.#baseUrl
      ? await openAICompatibleChat(
          { name: this.name, baseUrl: this.#baseUrl, apiKey: this.#apiKey, model: this.#model },
          [
            { role: "system", content: system },
            { role: "user", content: prompt }
          ],
          maxOutputTokens,
          12_000,
          0.7
        )
      : await geminiGenerateText({
          apiKey: this.#apiKey,
          model: this.#model,
          systemInstruction: system,
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          maxOutputTokens,
          timeoutMs: 12_000,
          temperature: 0.7
        });

    return truncateByCodepoints(sanitizeOneLine(raw), 20);
  }

  async chatReply(
    ctx: {
      state: string;
      isNight: boolean;
      mood: number;
      memory?: string;
      summary?: string;
      skills?: string;
      tools?: string;
      history: { role: "user" | "assistant"; content: string }[];
    },
    userMsg: ChatUserInput
  ) {
    const { text, images } = normalizeChatUserInput(userMsg);
    const userContent = buildOpenAIUserContent(text, images);

    const system = buildChatSystemPrompt({
      memory: ctx?.memory,
      summary: ctx?.summary,
      skills: (ctx as any)?.skills,
      tools: (ctx as any)?.tools
    });

    const limit = getModelLimitFromApis(this.name, this.#model);
    const maxOutputTokens = limit?.output ? Math.max(16, limit.output) : 8192;
    const inputBudgetTokens = limit?.context ? Math.max(512, limit.context - maxOutputTokens - 256) : 0;

    if (this.#baseUrl) {
      const messages = buildOpenAIMessagesWithBudget({
        system,
        history: (ctx.history ?? []).slice(-200),
        user: userContent,
        inputBudgetTokens: inputBudgetTokens || undefined
      });
      const raw = await openAICompatibleChat(
        { name: this.name, baseUrl: this.#baseUrl, apiKey: this.#apiKey, model: this.#model },
        messages,
        maxOutputTokens,
        180_000 // Increased timeout for DeepSeek which can be slower
      );
      return sanitizeChatText(raw);
    }

    const msgs = buildOpenAIMessagesWithBudget({
      system,
      history: (ctx.history ?? []).slice(-200),
      user: userContent,
      inputBudgetTokens: inputBudgetTokens || undefined
    });
    const systemForGemini = String(msgs[0]?.content ?? system);
    const contents = msgs
      .slice(1) // drop system
      .map((m: any): GeminiContent => {
        const role = m?.role === "assistant" ? "model" : "user";
        const content: OpenAIContent = m?.content;
        if (typeof content === "string") return { role, parts: [{ text: content }] };
        if (Array.isArray(content)) {
          const parts: GeminiPart[] = [];
          for (const p of content) {
            if (!p || typeof p !== "object") continue;
            if ((p as any).type === "text") {
              const t = String((p as any).text ?? "");
              if (t) parts.push({ text: t });
              continue;
            }
            if ((p as any).type === "image_url") {
              const url = String((p as any)?.image_url?.url ?? "");
              const parsed = parseImageDataUrl(url);
              if (parsed) {
                parts.push({ inlineData: { mimeType: parsed.mimeType, data: parsed.dataBase64 } });
              }
            }
          }
          if (!parts.length) parts.push({ text: "" });
          return { role, parts };
        }
        return { role, parts: [{ text: "" }] };
      });

    const raw = await geminiGenerateText({
      apiKey: this.#apiKey,
      model: this.#model,
      systemInstruction: systemForGemini,
      contents,
      maxOutputTokens,
      timeoutMs: 180_000, // Increased timeout
      temperature: 0.7
    });

    return sanitizeChatText(raw);
  }

  async summarizeConversation(opts: {
    currentSummary: string;
    newMessages: { role: "user" | "assistant"; content: string }[];
  }) {
    const maxOutputTokens = getModelLimitFromApis(this.name, this.#model)?.output ?? 360;
    const system =
      "你是“对话摘要器（短期记忆/工作记忆）”。任务：维护一份用于继续聊天的结构化摘要。\n" +
      "输出要求：严格 JSON（不要 Markdown，不要解释）。\n" +
      "Schema：\n" +
      "{\n" +
      "  \"version\": 1,\n" +
      "  \"profile\": string[],\n" +
      "  \"preferences\": string[],\n" +
      "  \"goals\": string[],\n" +
      "  \"decisions\": string[],\n" +
      "  \"constraints\": string[],\n" +
      "  \"todos\": string[],\n" +
      "  \"context\": string[]\n" +
      "}\n" +
      "规则：\n" +
      "- 中文为主；每条尽量短（<= 25 汉字），像条目笔记。\n" +
      "- 只保留对后续有用的信息：用户目标/偏好/约束/已决定事项/正在做的任务。\n" +
      "- 不要加入道德说教、时间提醒（例如“夜里说话…”）。\n" +
      "- 不要包含敏感信息（密码/API Key/地址等）。\n" +
      "- 字段没有内容就输出空数组 []。\n" +
      "- 总体不要超过约 1200 汉字。";

    const current = String(opts?.currentSummary ?? "").trim();
    const lines = (opts?.newMessages ?? [])
      .slice(-24)
      .map((m) => `${m.role === "assistant" ? "A" : "U"}: ${sanitizeOneLine(truncateByCodepoints(String(m.content ?? ""), 240))}`)
      .join("\n");

    const prompt =
      `现有摘要：\n${current || "(空)"}\n\n` +
      `新增对话：\n${lines || "(无)"}\n\n` +
      "请输出更新后的 JSON：";

    const raw = this.#baseUrl
      ? await openAICompatibleChat(
          { name: this.name, baseUrl: this.#baseUrl, apiKey: this.#apiKey, model: this.#model },
          [
            { role: "system", content: system },
            { role: "user", content: prompt }
          ],
          maxOutputTokens,
          18_000,
          0.2
        )
      : await geminiGenerateText({
          apiKey: this.#apiKey,
          model: this.#model,
          systemInstruction: system,
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          maxOutputTokens,
          timeoutMs: 18_000,
          temperature: 0.2
        });

    return sanitizeChatText(raw);
  }

  async extractMemoryNotes(
    ctx: {
      state: string;
      isNight: boolean;
      mood: number;
      memory?: string;
      summary?: string;
      history: { role: "user" | "assistant"; content: string }[];
    },
    turn: { user: string; assistant: string }
  ) {
    const maxOutputTokens = getModelLimitFromApis(this.name, this.#model)?.output ?? 700;
    const memory = String(ctx?.memory ?? "").trim();
    const system =
      "你是“长期记忆提取器”。你会从对话中提取适合长期记住的稳定信息（偏好、名字、长期目标、项目背景）。\n" +
      "目标：提取对未来仍然有用且稳定的信息，写入长期记忆。\n" +
      "规则：\n" +
      "- 只提取用户明确表达、且未来仍可能成立的信息。\n" +
      "- 如果用户在本轮明确给出名字或希望的称呼（我叫X / 请叫我Y / 以后叫我Y / 你可以叫我Y），必须提取。\n" +
      "- 优先保留用户原话或贴近原话的表达，确保语义完整，不要截断成半句话。\n" +
      "- 不要提取一次性任务、临时计划、短期状态。\n" +
      "- 不要提取敏感信息（密码/API key/地址/身份证等）。\n" +
      "- 如不确定，输出空数组 []。\n" +
      "输出格式：严格 JSON 数组（不要 Markdown/代码块/解释），最多 4 条。每个元素二选一：\n" +
      "1) 可覆盖事实（推荐）：{\"kind\":\"profile|preference|project|note\",\"key\":\"...\",\"value\":\"...\"}\n" +
      "2) 普通笔记：{\"kind\":\"profile|preference|project|note\",\"content\":\"...\"}\n" +
      "可用 key 示例（尽量用这些，避免无限发明新 key）：\n" +
      "- user.name / user.call_me / user.language / user.response_style\n" +
      "- project.name / project.repo / project.stack\n" +
      "- app.preference (如“不跑 build”)";

    const buildPrompt = (badOutput?: string) => {
      const bad = String(badOutput ?? "").trim();
      return (
        (memory ? `现有长期记忆（可能不完整）：\n${memory}\n\n` : "") +
        `用户：${String(turn?.user ?? "").trim()}\n` +
        `助手：${String(turn?.assistant ?? "").trim()}\n\n` +
        (bad
          ? `你上次输出不符合要求（不是严格 JSON 数组 / 或被截断）。请修复为严格 JSON 数组，仅输出 JSON：\n${bad.slice(
              0,
              1600
            )}\n\n`
          : "") +
        "请输出 JSON："
      );
    };

    const run = async (mode: "primary" | "repair", badOutput?: string) => {
      const temperature = 0;
      const maxTokens = maxOutputTokens;
      const timeoutMs = mode === "repair" ? 20_000 : 25_000;
      const prompt = buildPrompt(badOutput);

      return this.#baseUrl
        ? await openAICompatibleChat(
            { name: this.name, baseUrl: this.#baseUrl, apiKey: this.#apiKey, model: this.#model },
            [
              { role: "system", content: system },
              { role: "user", content: prompt }
            ],
            maxTokens,
            timeoutMs,
            temperature
          )
        : await geminiGenerateText({
            apiKey: this.#apiKey,
            model: this.#model,
            systemInstruction: system,
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            maxOutputTokens: maxTokens,
            timeoutMs,
            temperature
          });
    };

    const raw1 = await run("primary");
    const items1 = parseMemoryExtractorJson(raw1);
    if (items1.length) return items1;

    // Retry once in strict "repair" mode when the model output is non-empty but unparsable.
    const nonEmpty = String(raw1 ?? "").trim();
    if (nonEmpty && !/^\s*\[\s*\]\s*$/.test(nonEmpty)) {
      const raw2 = await run("repair", nonEmpty);
      return parseMemoryExtractorJson(raw2);
    }

    return items1;
  }

  async rerankMemory(opts: {
    query: string;
    limit: number;
    facts: { id: number; kind: string; key: string; value: string }[];
    notes: { id: number; kind: string; content: string }[];
  }) {
    const maxOutputTokens = getModelLimitFromApis(this.name, this.#model)?.output ?? 400;
    const limit = Math.max(0, Math.min(40, Math.floor(Number(opts?.limit) || 0)));
    if (!limit) return { factIds: [], noteIds: [] };

    const query = sanitizeOneLine(String(opts?.query ?? ""));
    const facts = Array.isArray(opts?.facts) ? opts.facts : [];
    const notes = Array.isArray(opts?.notes) ? opts.notes : [];

    const system =
      "你是“长期记忆重排器”。任务：从候选记忆中选出最相关、最有用的条目，帮助回答用户当前问题。\n" +
      "输出要求：严格 JSON 对象，仅输出一次。\n" +
      "格式：{\"facts\":[id...],\"notes\":[id...]}\n" +
      "规则：\n" +
      `- 总数量（facts+notes）<= ${limit}。\n` +
      "- 只允许选择候选列表中出现的 id；不要发明 id。\n" +
      "- 优先选择与当前问题直接相关的事实/偏好/项目背景。\n" +
      "- 不要为了凑数选无关内容；不相关就留空数组。\n" +
      "- 不要输出解释、不要输出 Markdown。";

    const factLines = facts
      .slice(0, 40)
      .map((f) => {
        const id = Math.floor(Number((f as any).id) || 0);
        const kind = sanitizeOneLine(String((f as any).kind ?? "fact"));
        const key = sanitizeOneLine(String((f as any).key ?? ""));
        const value = sanitizeOneLine(truncateByCodepoints(String((f as any).value ?? ""), 120));
        return `- id=${id} kind=${kind} ${key}: ${value}`;
      })
      .join("\n");

    const noteLines = notes
      .slice(0, 80)
      .map((n) => {
        const id = Math.floor(Number((n as any).id) || 0);
        const kind = sanitizeOneLine(String((n as any).kind ?? "note"));
        const content = sanitizeOneLine(truncateByCodepoints(String((n as any).content ?? ""), 140));
        return `- id=${id} kind=${kind} ${content}`;
      })
      .join("\n");

    const prompt =
      `用户当前问题：\n${query || "(空)"}\n\n` +
      `候选 Facts：\n${factLines || "(无)"}\n\n` +
      `候选 Notes：\n${noteLines || "(无)"}\n\n` +
      "请输出 JSON：";

    const raw = this.#baseUrl
      ? await openAICompatibleChat(
          { name: this.name, baseUrl: this.#baseUrl, apiKey: this.#apiKey, model: this.#model },
          [
            { role: "system", content: system },
            { role: "user", content: prompt }
          ],
          maxOutputTokens,
          12_000,
          0.1
        )
      : await geminiGenerateText({
          apiKey: this.#apiKey,
          model: this.#model,
          systemInstruction: system,
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          maxOutputTokens,
          timeoutMs: 15_000,
          temperature: 0.1
        });

    const parsed = parseRerankResult(raw);
    return parsed ?? { factIds: [], noteIds: [] };
  }

  isConfigured() {
    return Boolean(this.#apiKey);
  }
}

export class LLMService {
  #provider: LLMProvider | null = null;
  #config: LLMConfig | null = null;

  constructor(opts?: { config?: LLMConfig | null }) {
    this.#config = opts?.config ?? null;
    this.#provider = this.#createProvider();
  }

  setConfig(config: LLMConfig | null) {
    this.#config = config;
    this.#provider = this.#createProvider();
  }

  #createProvider(): LLMProvider | null {
    const configProvider = normalizeProviderName(this.#config?.provider);
    const envProvider = normalizeProviderName(process.env.LLM_PROVIDER);

    // Precedence: Config (if specific) > Env > Config (if auto) > Auto
    const selected =
      configProvider && configProvider !== "auto" ? configProvider : envProvider ?? configProvider ?? "auto";

    console.log(
      `[llm] createProvider: selected=${selected} (config=${configProvider}, env=${envProvider})`
    );

    if (selected === "off") return null;

    const openaiBaseUrl =
      nonEmptyString(process.env.OPENAI_BASE_URL) ||
      nonEmptyString(this.#config?.openai?.baseUrl) ||
      "https://api.openai.com/v1";
    const openaiModel =
      nonEmptyString(process.env.OPENAI_MODEL) || nonEmptyString(this.#config?.openai?.model) || "gpt-4o-mini";
    const openaiApiKey = nonEmptyString(process.env.OPENAI_API_KEY) || nonEmptyString(this.#config?.openai?.apiKey);

    const deepseekBaseUrl =
      nonEmptyString(process.env.DEEPSEEK_BASE_URL) ||
      nonEmptyString(this.#config?.deepseek?.baseUrl) ||
      "https://api.deepseek.com/v1";
    const deepseekModel =
      nonEmptyString(process.env.DEEPSEEK_MODEL) ||
      nonEmptyString(this.#config?.deepseek?.model) ||
      "deepseek-chat";
    const deepseekApiKey =
      nonEmptyString(process.env.DEEPSEEK_API_KEY) || nonEmptyString(this.#config?.deepseek?.apiKey);

    console.log(`[llm] deepseek config: baseUrl=${deepseekBaseUrl}, model=${deepseekModel}, hasApiKey=${Boolean(deepseekApiKey)}, apiKeyLen=${(deepseekApiKey ?? "").length}`);

    const aistudioApiKey =
      nonEmptyString(process.env.AISTUDIO_API_KEY) || nonEmptyString(this.#config?.aistudio?.apiKey);
    const aistudioModel =
      nonEmptyString(process.env.AISTUDIO_MODEL) || nonEmptyString(this.#config?.aistudio?.model) || "gemini-2.0-flash";
    const aistudioBaseUrl =
      nonEmptyString(process.env.AISTUDIO_BASE_URL) || nonEmptyString(this.#config?.aistudio?.baseUrl);

    const openai = new OpenAICompatibleProvider({
      name: "openai",
      baseUrl: openaiBaseUrl,
      apiKey: openaiApiKey,
      model: openaiModel
    });

    const deepseek = new OpenAICompatibleProvider({
      name: "deepseek",
      baseUrl: deepseekBaseUrl,
      apiKey: deepseekApiKey,
      model: deepseekModel
    });

    const aistudio = new AIStudioProvider({ apiKey: aistudioApiKey, model: aistudioModel, baseUrl: aistudioBaseUrl });

    console.log(`[llm] isConfigured: openai=${openai.isConfigured()}, deepseek=${deepseek.isConfigured()}, aistudio=${aistudio.isConfigured()}`);

    if (selected === "openai") return openai.isConfigured() ? openai : null;
    if (selected === "deepseek") return deepseek.isConfigured() ? deepseek : null;
    if (selected === "aistudio") return aistudio.isConfigured() ? aistudio : null;

    // auto
    if (openai.isConfigured()) return openai;
    if (deepseek.isConfigured()) return deepseek;
    if (aistudio.isConfigured()) return aistudio;
    return null;
  }

  get providerName() {
    return this.#provider?.name ?? "fallback";
  }

  get enabled() {
    return Boolean(this.#provider);
  }

  async generateBubble(ctx: { state: string; isNight: boolean; mood: number }) {
    const fallback = () => truncateByCodepoints(ruleBasedBubble(ctx), 20);
    if (!this.#provider) return fallback();
    try {
      const bubble = truncateByCodepoints(await this.#provider.generateBubble(ctx), 20);
      if (isLowValueAckReply(bubble)) return fallback();
      return bubble;
    } catch (err) {
      console.warn("[llm] bubble fallback:", err);
      return fallback();
    }
  }

  async chatReply(
    ctx: {
      state: string;
      isNight: boolean;
      mood: number;
      /** Durable memory (short, human-readable). */
      memory?: string;
      /** Rolling short-term summary for continuity (best-practice working memory). */
      summary?: string;
      skills?: string;
      tools?: string;
      history: { role: "user" | "assistant"; content: string }[];
    },
    userMsg: ChatUserInput
  ) {
    const refuse = "我不想回复你这句话";

    const { text: userTextRaw, images } = normalizeChatUserInput(userMsg);
    const userText = String(userTextRaw ?? "");
    const hasImages = images.length > 0;

    const historyRaw = Array.isArray(ctx?.history) ? ctx.history : [];

    // Sanitize assistant history so "night nag" phrases don't keep reinforcing themselves.
    const history = historyRaw
      .map((m: any) => {
        if (!m || typeof m !== "object") return null;
        const role = m.role === "assistant" ? "assistant" : "user";
        const content = typeof m.content === "string" ? m.content : "";
        return { role, content: role === "assistant" ? stripNightNagPrefix(content) : content };
      })
      .filter((m): m is { role: "user" | "assistant"; content: string } => Boolean(m));

    const lastAssistant = [...history]
      .reverse()
      .find((m: any) => m && m.role === "assistant" && typeof m.content === "string")
      ?.content;

    const fallback = () => stripNightNagPrefix(ruleBasedChatReply(ctx as any, userText));

    const finalize = (raw: string) => {
      const normalized = stripNightNagPrefix(sanitizeChatText(String(raw ?? "")));
      if (!normalized.trim()) return fallback();

      // Heuristics for "too low value" / repetition should be applied to a one-line projection,
      // but we still return the original multi-line markdown to the UI when it's good.
      const oneLine = sanitizeOneLine(normalized);
      if (!oneLine || isLowValueAckReply(oneLine)) return fallback();
      if (lastAssistant && sanitizeOneLine(lastAssistant) === oneLine) return fallback();
      return normalized;
    };

    if (!this.#provider) {
      console.warn("[llm] no provider configured, using fallback");
      return finalize(fallback());
    }
    try {
      console.log(
        `[llm] chatReply via ${this.#provider.name}, textLen=${userText.length}, images=${hasImages ? images.length : 0}`
      );
      const raw = await this.#provider.chatReply(
        { ...ctx, history },
        hasImages ? ({ text: userText, images } satisfies Exclude<ChatUserInput, string>) : userText
      );
      // If the provider returns an empty payload (should be rare), treat it as a refusal rather than a generic fallback.
      if (!String(raw ?? "").trim()) {
        console.warn("[llm] empty response from provider");
        return refuse;
      }
      console.log(`[llm] chatReply success, response length: ${raw.length}`);
      return finalize(raw);
    } catch (err: any) {
      const errMsg = err?.message ?? String(err);
      const errStack = err?.stack ?? "";
      console.error("[llm] chat error:", errMsg);
      if (errStack) console.error("[llm] stack:", errStack);
      // Provide more specific error info for debugging
      if (errMsg.includes("HTTP 4")) {
        console.error("[llm] API returned client error - check API key and request format");
      } else if (errMsg.includes("HTTP 5")) {
        console.error("[llm] API returned server error - DeepSeek service may be down");
      } else if (errMsg.includes("abort") || errMsg.includes("timeout")) {
        console.error("[llm] Request timed out - network issue or slow response");
      }
      return refuse;
    }
  }

  async summarizeConversation(opts: {
    currentSummary: string;
    newMessages: { role: "user" | "assistant"; content: string }[];
  }): Promise<{ summaryText: string; summaryJson: ConversationSummaryV1 | null }> {
    const currentText = sanitizeChatText(String(opts?.currentSummary ?? ""));

    if (!this.#provider || typeof this.#provider.summarizeConversation !== "function") {
      return { summaryText: currentText, summaryJson: null };
    }

    try {
      const raw = await this.#provider.summarizeConversation({
        currentSummary: currentText,
        newMessages: Array.isArray(opts?.newMessages) ? opts.newMessages : []
      });

      const cleaned = stripNightNagPrefix(sanitizeChatText(raw));
      if (!cleaned.trim()) return { summaryText: currentText, summaryJson: null };

      const parsed = parseConversationSummaryV1(cleaned);
      if (parsed) {
        const rendered = renderConversationSummary(parsed);
        return { summaryText: rendered || currentText, summaryJson: parsed };
      }

      // Provider didn't follow JSON format; keep the old text as a best-effort fallback.
      return { summaryText: cleaned, summaryJson: null };
    } catch (err) {
      console.warn("[llm] summary skipped:", err);
      return { summaryText: currentText, summaryJson: null };
    }
  }

  async rerankMemory(opts: {
    query: string;
    limit: number;
    facts: { id: number; kind: string; key: string; value: string }[];
    notes: { id: number; kind: string; content: string }[];
  }): Promise<{ factIds: number[]; noteIds: number[] } | null> {
    if (!this.#provider || typeof this.#provider.rerankMemory !== "function") return null;

    const query = String(opts?.query ?? "").trim();
    const limit = Math.max(0, Math.min(40, Math.floor(Number(opts?.limit) || 0)));
    if (!query || !limit) return null;

    try {
      const facts = Array.isArray(opts?.facts) ? opts.facts : [];
      const notes = Array.isArray(opts?.notes) ? opts.notes : [];
      const raw = await this.#provider.rerankMemory({ query, limit, facts, notes });
      const out = raw && typeof raw === "object" ? raw : null;
      if (!out) return null;

      const factIds = Array.isArray((out as any).factIds) ? (out as any).factIds : (out as any).facts;
      const noteIds = Array.isArray((out as any).noteIds) ? (out as any).noteIds : (out as any).notes;
      const norm = parseRerankResult(JSON.stringify({ facts: factIds, notes: noteIds }));
      return norm;
    } catch (err) {
      console.warn("[llm] rerank skipped:", err);
      return null;
    }
  }

  async extractMemoryNotes(
    ctx: {
      state: string;
      isNight: boolean;
      mood: number;
      memory?: string;
      summary?: string;
      history: { role: "user" | "assistant"; content: string }[];
    },
    turn: { user: string; assistant: string }
  ): Promise<
    {
      kind: "preference" | "profile" | "project" | "note";
      content?: string;
      key?: string;
      value?: string;
    }[]
  > {
    if (!this.#provider || typeof this.#provider.extractMemoryNotes !== "function") return [];

    try {
      const items = await this.#provider.extractMemoryNotes(ctx, turn);
      if (!Array.isArray(items)) return [];

      const out: {
        kind: "preference" | "profile" | "project" | "note";
        content?: string;
        key?: string;
        value?: string;
      }[] = [];
      for (const it of items) {
        const kindRaw = String((it as any)?.kind ?? "note").toLowerCase();
        const kind: "preference" | "profile" | "project" | "note" =
          kindRaw === "preference" || kindRaw === "profile" || kindRaw === "project" ? (kindRaw as any) : "note";

        const key = String((it as any)?.key ?? "").trim();
        const value = String((it as any)?.value ?? "").trim();
        const content = String((it as any)?.content ?? "").trim();

        if (key && value) {
          out.push({
            kind,
            key: smartTruncatePreferBoundary(key, 64),
            value: smartTruncatePreferBoundary(value, 600)
          });
          continue;
        }

        if (!content) continue;
        out.push({ kind, content: smartTruncatePreferBoundary(content, 600) });
      }
      return out.slice(0, 4);
    } catch (err) {
      console.warn("[llm] memory-extract skipped:", err);
      return [];
    }
  }
}
