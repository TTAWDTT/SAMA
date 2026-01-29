import type { LLMConfig, LLMProviderName } from "../protocol/types";
import { buildBubbleSystemPrompt, buildChatSystemPrompt } from "../agent/prompts";

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
      history: { role: "user" | "assistant"; content: string }[];
    },
    userMsg: string
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

  // The extractor prompt requests strict JSON, but be defensive.
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  const slice = start >= 0 && end > start ? text.slice(start, end + 1) : text;

  try {
    const parsed: any = JSON.parse(slice);
    if (!Array.isArray(parsed)) return [];

    const out: {
      kind: "preference" | "profile" | "project" | "note";
      content?: string;
      key?: string;
      value?: string;
    }[] = [];

    for (const item of parsed.slice(0, 8)) {
      const kindRaw = String(item?.kind ?? "note").toLowerCase();
      const kind: "preference" | "profile" | "project" | "note" =
        kindRaw === "preference" || kindRaw === "profile" || kindRaw === "project" ? (kindRaw as any) : "note";

      const key = String(item?.key ?? "").trim();
      const value = String(item?.value ?? "").trim();
      const content = String(item?.content ?? "").trim();

      // Prefer keyed facts when provided (overwritable durable memory).
      if (key && value) {
        const clippedKey = truncateByCodepoints(key, 48);
        const clippedValue = truncateByCodepoints(value, 160);
        out.push({ kind, key: clippedKey, value: clippedValue });
        continue;
      }

      if (!content) continue;

      // Keep each memory short and human-readable.
      const clipped = truncateByCodepoints(content, 120);
      out.push({ kind, content: clipped });
    }
    return out.slice(0, 4);
  } catch {
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

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Math.max(1, timeoutMs));
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function openAICompatibleChat(
  opts: OpenAICompatibleOpts,
  messages: any[],
  maxTokens: number,
  timeoutMs: number
) {
  const url = `${opts.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        ...headers
      },
      body: JSON.stringify({
        model: opts.model,
        messages,
        temperature: 0.7,
        max_tokens: maxTokens
      })
    },
    timeoutMs
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[${opts.name}] HTTP ${res.status}: ${text}`);
  }

  const data: any = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error(`[${opts.name}] unexpected response shape`);
  return content;
}

type GeminiContent = { role: "user" | "model"; parts: { text: string }[] };

async function geminiGenerateText(opts: {
  apiKey: string;
  model: string;
  systemInstruction: string;
  contents: GeminiContent[];
  maxOutputTokens: number;
  timeoutMs: number;
}) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(opts.model)}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;

  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: opts.systemInstruction }] },
        contents: opts.contents,
        generationConfig: {
          temperature: 0.7,
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
      60,
      12_000
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
      history: { role: "user" | "assistant"; content: string }[];
    },
    userMsg: string
  ) {
    const system = buildChatSystemPrompt({ memory: ctx?.memory, summary: ctx?.summary });
    const raw = await openAICompatibleChat(
      this.#opts,
      [
        {
          role: "system",
          content: system
        },
        ...(ctx.history ?? []).slice(-20),
        { role: "user", content: userMsg }
      ],
      600,
      25_000
    );
    return sanitizeChatText(raw);
  }

  async summarizeConversation(opts: {
    currentSummary: string;
    newMessages: { role: "user" | "assistant"; content: string }[];
  }) {
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
      360,
      18_000
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
    const memory = String(ctx?.memory ?? "").trim();
    const system =
      "你是“长期记忆提取器”。你会从对话中提取适合长期记住的稳定信息（偏好、名字、长期目标、项目背景）。\n" +
      "规则：\n" +
      "- 只提取用户明确表达、且未来仍可能成立的信息。\n" +
      "- 不要提取一次性任务、临时计划、短期状态。\n" +
      "- 不要提取敏感信息（密码/API key/地址/身份证等）。\n" +
      "- 如不确定，输出空数组 []。\n" +
      "输出格式：严格 JSON 数组，最多 4 条。每个元素二选一：\n" +
      "1) 可覆盖事实（推荐）：{\"kind\":\"profile|preference|project|note\",\"key\":\"...\",\"value\":\"...\"}\n" +
      "2) 普通笔记：{\"kind\":\"profile|preference|project|note\",\"content\":\"...\"}\n" +
      "可用 key 示例（尽量用这些，避免无限发明新 key）：\n" +
      "- user.name / user.language / user.response_style\n" +
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
      220,
      12_000
    );
    return parseMemoryExtractorJson(raw);
  }

  async rerankMemory(opts: {
    query: string;
    limit: number;
    facts: { id: number; kind: string; key: string; value: string }[];
    notes: { id: number; kind: string; content: string }[];
  }) {
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
      180,
      12_000
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

    const raw = this.#baseUrl
      ? await openAICompatibleChat(
          { name: this.name, baseUrl: this.#baseUrl, apiKey: this.#apiKey, model: this.#model },
          [
            { role: "system", content: system },
            { role: "user", content: prompt }
          ],
          60,
          12_000
        )
      : await geminiGenerateText({
          apiKey: this.#apiKey,
          model: this.#model,
          systemInstruction: system,
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          maxOutputTokens: 80,
          timeoutMs: 12_000
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
      history: { role: "user" | "assistant"; content: string }[];
    },
    userMsg: string
  ) {
    const system = buildChatSystemPrompt({ memory: ctx?.memory, summary: ctx?.summary });

    if (this.#baseUrl) {
      const raw = await openAICompatibleChat(
        { name: this.name, baseUrl: this.#baseUrl, apiKey: this.#apiKey, model: this.#model },
        [
          { role: "system", content: system },
          ...(ctx.history ?? []).slice(-20),
          { role: "user", content: userMsg }
        ],
        600,
        25_000
      );
      return sanitizeChatText(raw);
    }

    const history = (ctx.history ?? []).slice(-20).map((m: any): GeminiContent => {
      const role = m?.role === "assistant" ? "model" : "user";
      const content = typeof m?.content === "string" ? m.content : "";
      return { role, parts: [{ text: content }] };
    });

    const raw = await geminiGenerateText({
      apiKey: this.#apiKey,
      model: this.#model,
      systemInstruction: system,
      contents: [...history, { role: "user", parts: [{ text: userMsg }] }],
      maxOutputTokens: 512,
      timeoutMs: 25_000
    });

    return sanitizeChatText(raw);
  }

  async summarizeConversation(opts: {
    currentSummary: string;
    newMessages: { role: "user" | "assistant"; content: string }[];
  }) {
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
          360,
          18_000
        )
      : await geminiGenerateText({
          apiKey: this.#apiKey,
          model: this.#model,
          systemInstruction: system,
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          maxOutputTokens: 360,
          timeoutMs: 18_000
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
    const memory = String(ctx?.memory ?? "").trim();
    const system =
      "你是“长期记忆提取器”。你会从对话中提取适合长期记住的稳定信息（偏好、名字、长期目标、项目背景）。\n" +
      "规则：\n" +
      "- 只提取用户明确表达、且未来仍可能成立的信息。\n" +
      "- 不要提取一次性任务、临时计划、短期状态。\n" +
      "- 不要提取敏感信息（密码/API key/地址/身份证等）。\n" +
      "- 如不确定，输出空数组 []。\n" +
      "输出格式：严格 JSON 数组，最多 4 条。每个元素二选一：\n" +
      "1) 可覆盖事实（推荐）：{\"kind\":\"profile|preference|project|note\",\"key\":\"...\",\"value\":\"...\"}\n" +
      "2) 普通笔记：{\"kind\":\"profile|preference|project|note\",\"content\":\"...\"}\n" +
      "可用 key 示例（尽量用这些，避免无限发明新 key）：\n" +
      "- user.name / user.language / user.response_style\n" +
      "- project.name / project.repo / project.stack\n" +
      "- app.preference (如“不跑 build”)";

    const prompt =
      (memory ? `现有长期记忆（可能不完整）：\n${memory}\n\n` : "") +
      `用户：${String(turn?.user ?? "").trim()}\n` +
      `助手：${String(turn?.assistant ?? "").trim()}\n\n` +
      "请输出 JSON：";

    const raw = this.#baseUrl
      ? await openAICompatibleChat(
          { name: this.name, baseUrl: this.#baseUrl, apiKey: this.#apiKey, model: this.#model },
          [
            { role: "system", content: system },
            { role: "user", content: prompt }
          ],
          220,
          12_000
        )
      : await geminiGenerateText({
          apiKey: this.#apiKey,
          model: this.#model,
          systemInstruction: system,
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          maxOutputTokens: 220,
          timeoutMs: 12_000
        });

    return parseMemoryExtractorJson(raw);
  }

  async rerankMemory(opts: {
    query: string;
    limit: number;
    facts: { id: number; kind: string; key: string; value: string }[];
    notes: { id: number; kind: string; content: string }[];
  }) {
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
          180,
          12_000
        )
      : await geminiGenerateText({
          apiKey: this.#apiKey,
          model: this.#model,
          systemInstruction: system,
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          maxOutputTokens: 180,
          timeoutMs: 12_000
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
    const selected =
      normalizeProviderName(process.env.LLM_PROVIDER) ?? normalizeProviderName(this.#config?.provider) ?? "auto";

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

    const aistudioApiKey =
      nonEmptyString(process.env.AISTUDIO_API_KEY) || nonEmptyString(this.#config?.aistudio?.apiKey);
    const aistudioModel =
      nonEmptyString(process.env.AISTUDIO_MODEL) || nonEmptyString(this.#config?.aistudio?.model) || "gemini-1.5-flash";
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
      history: { role: "user" | "assistant"; content: string }[];
    },
    userMsg: string
  ) {
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

    const fallback = () => stripNightNagPrefix(ruleBasedChatReply(ctx as any, userMsg));

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

    if (!this.#provider) return finalize(fallback());
    try {
      return finalize(await this.#provider.chatReply({ ...ctx, history }, userMsg));
    } catch (err) {
      console.warn("[llm] chat fallback:", err);
      return finalize(fallback());
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
          out.push({ kind, key: truncateByCodepoints(key, 48), value: truncateByCodepoints(value, 160) });
          continue;
        }

        if (!content) continue;
        out.push({ kind, content: truncateByCodepoints(content, 120) });
      }
      return out.slice(0, 4);
    } catch (err) {
      console.warn("[llm] memory-extract skipped:", err);
      return [];
    }
  }
}
