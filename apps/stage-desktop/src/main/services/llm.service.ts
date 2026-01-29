import type { LLMConfig, LLMProviderName } from "../protocol/types";

export interface LLMProvider {
  name: string;
  generateBubble(ctx: { state: string; isNight: boolean; mood: number }): Promise<string>;
  chatReply(
    ctx: {
      state: string;
      isNight: boolean;
      mood: number;
      history: { role: "user" | "assistant"; content: string }[];
    },
    userMsg: string
  ): Promise<string>;
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
  const prefix = ctx.isNight ? "夜里说话更轻点…" : "";
  const trimmed = userMsg.trim();
  if (!trimmed) return "嗯？";
  const compact = trimmed.replace(/\s+/g, "");
  const seed = hashStringCodepoints(`${compact}|${ctx.state}|${ctx.isNight ? "n" : "d"}|${ctx.mood.toFixed(2)}`);

  // Special-cases for built-in diagnostics.
  if (compact.startsWith("测试气泡") || /^test$/i.test(compact)) return `${prefix}气泡显示正常 ✅`.trim();

  // Short utterances are common in chat; avoid a single repetitive "我听到了".
  if (compact.length <= 4) {
    if (/^(hi|hello|hey)$/i.test(compact)) return `${prefix}你好，我在。`.trim();
    if (/(你好|嗨|在吗|喂)/.test(compact)) return `${prefix}我在呢。`.trim();
    if (/(谢谢|谢啦|thx|thanks)/i.test(compact)) return `${prefix}不客气。`.trim();
    if (/[？?]$/.test(compact)) return `${prefix}你想问哪一部分？`.trim();

    // Add a tiny bit of variety so it doesn't feel "stuck".
    return pickVariant(
      [
        `${prefix}我在呢，你继续说。`.trim(),
        `${prefix}嗯，我听着。`.trim(),
        `${prefix}怎么啦？`.trim(),
        `${prefix}我在这儿。`.trim()
      ],
      seed
    );
  }
  if (ctx.state === "FOCUS") return `${prefix}你先忙，我在这儿。`.trim();
  if (ctx.mood < 0.35) return `${prefix}我可能理解得不够，但我愿意听。`.trim();
  return pickVariant(
    [
      `${prefix}你想先从哪一点说起？`.trim(),
      `${prefix}你希望我怎么陪你？`.trim(),
      `${prefix}要不要先讲最困扰你的那一段？`.trim()
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
    const raw = await openAICompatibleChat(
      this.#opts,
      [
        {
          role: "system",
          content:
            "你是桌面陪伴助手，只输出一行中文短句。语气温和、带点不确定，不要自称理解一切。不要贴标签。不要只输出“我听到了/收到/嗯…”这类纯确认句。"
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
    ctx: { state: string; isNight: boolean; mood: number; history: any[] },
    userMsg: string
  ) {
    const raw = await openAICompatibleChat(
      this.#opts,
      [
        {
          role: "system",
          content:
            "你是温和的桌面陪伴助手。不要声称你完全理解用户。回答简洁自然，中文为主。必须对用户消息做出具体回应，避免只回复“我听到了/收到”。"
        },
        ...(ctx.history ?? []).slice(-20),
        { role: "user", content: userMsg }
      ],
      220,
      25_000
    );
    return sanitizeOneLine(raw);
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
    const system =
      "你是桌面陪伴助手，只输出一行中文短句。语气温和、带点不确定，不要自称理解一切。不要贴标签。不要只输出“我听到了/收到/嗯…”这类纯确认句。";
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
    ctx: { state: string; isNight: boolean; mood: number; history: any[] },
    userMsg: string
  ) {
    const system =
      "你是温和的桌面陪伴助手。不要声称你完全理解用户。回答简洁自然，中文为主。必须对用户消息做出具体回应，避免只回复“我听到了/收到”。";

    if (this.#baseUrl) {
      const raw = await openAICompatibleChat(
        { name: this.name, baseUrl: this.#baseUrl, apiKey: this.#apiKey, model: this.#model },
        [
          { role: "system", content: system },
          ...(ctx.history ?? []).slice(-20),
          { role: "user", content: userMsg }
        ],
        220,
        25_000
      );
      return sanitizeOneLine(raw);
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
      maxOutputTokens: 320,
      timeoutMs: 25_000
    });

    return sanitizeOneLine(raw);
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
    ctx: { state: string; isNight: boolean; mood: number; history: any[] },
    userMsg: string
  ) {
    const lastAssistant = Array.isArray(ctx?.history)
      ? [...ctx.history]
          .reverse()
          .find((m: any) => m && m.role === "assistant" && typeof m.content === "string")
          ?.content
      : undefined;

    const fallback = () => ruleBasedChatReply(ctx, userMsg);

    const finalize = (raw: string) => {
      const normalized = sanitizeOneLine(String(raw ?? ""));
      if (!normalized || isLowValueAckReply(normalized)) return fallback();
      if (lastAssistant && sanitizeOneLine(lastAssistant) === normalized) return fallback();
      return normalized;
    };

    if (!this.#provider) return finalize(fallback());
    try {
      return finalize(await this.#provider.chatReply(ctx, userMsg));
    } catch (err) {
      console.warn("[llm] chat fallback:", err);
      return finalize(fallback());
    }
  }
}
