import type { ActionCommand, ChatRequest, ChatResponse, SensorUpdate, UserInteraction } from "@sama/shared";
import type { CompanionState } from "../protocol/types";
import { LLMService } from "./llm.service";
import { MemoryService } from "./memory.service";
import { SkillService } from "./skill.service";
import { ToolService, renderToolDocs } from "./tool.service";
import { webSearch } from "./web-search.service";
import { formatToolResults, parseToolCalls } from "../agent/tool-parser";

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
}

function todayKey(ts: number) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

type ProactiveSignal =
  | { kind: "CLIPBOARD_TIME"; ts: number; excerpt: string }
  | { kind: "CLIPBOARD_LINK"; ts: number; url: string; site?: string }
  | { kind: "HEALTH_LONG_SESSION"; ts: number; minutes: number }
  | { kind: "HEALTH_LATE_NIGHT"; ts: number; localTime: string }
  | { kind: "SYSTEM_BATTERY"; ts: number; percent: number; charging: boolean; threshold: 50 | 20 }
  | { kind: "CONTEXT_FOCUS"; ts: number; app: string }
  | { kind: "CONTEXT_ENTERTAINMENT"; ts: number; app: string }
  | { kind: "CONTEXT_SOCIAL_FATIGUE"; ts: number; app: string }
  | { kind: "RANDOM_TIP"; ts: number };

function pickApproachExpression(state: CompanionState, isNight: boolean): ActionCommand["expression"] {
  if (state === "SOCIAL_CHECK_LOOP") return isNight ? "TIRED" : "SHY";
  return isNight ? "TIRED" : "NEUTRAL";
}

function normalizeBubbleText(s: string) {
  return String(s ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripMarkdownForBubble(md: string) {
  const s = String(md ?? "");

  // Drop fenced code blocks entirely (bubble should not show code).
  let out = s.replace(/```[\s\S]*?```/g, "");

  // Links: [text](url) -> text
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Inline code: `x` -> x
  out = out.replace(/`([^`]+)`/g, "$1");

  // Headings / quotes / list markers
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  out = out.replace(/^\s{0,3}>\s?/gm, "");
  out = out.replace(/^\s{0,3}([-*]|\d+\.)\s+/gm, "");

  // Emphasis markers
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
  out = out.replace(/\*([^*]+)\*/g, "$1");
  out = out.replace(/__([^_]+)__/g, "$1");
  out = out.replace(/_([^_]+)_/g, "$1");

  return out.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function pickBubbleTextFromReply(reply: string) {
  const plain = stripMarkdownForBubble(reply);
  if (!plain) return "";

  // Prefer the first paragraph; bubbles should be short and non-obtrusive.
  const firstPara = plain.split(/\n{2,}/)[0]?.trim();
  return firstPara || plain.split("\n")[0]?.trim() || plain;
}

function bubbleDurationForText(text: string) {
  const n = Array.from(text).length;
  // 3.2s base + per-char time, clamped to a reasonable range.
  return Math.max(3200, Math.min(12_000, 3200 + n * 55));
}

function formatLocalHm(ts: number) {
  try {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  } catch {
    return "";
  }
}

function isLateNight(ts: number) {
  try {
    const d = new Date(ts);
    const h = d.getHours();
    const m = d.getMinutes();
    return h > 23 || (h === 23 && m >= 30) || h < 6;
  } catch {
    return false;
  }
}

function normalizeAppName(raw: string) {
  const s = String(raw ?? "").trim();
  return s || "Unknown.exe";
}

function classifyContext(appRaw: string, titleRaw?: string): "focus" | "entertainment" | "social" | "other" {
  const app = normalizeAppName(appRaw).toLowerCase();
  const title = String(titleRaw ?? "").toLowerCase();

  const focusApps = new Set([
    "code.exe",
    "cursor.exe",
    "vscode.exe",
    "devenv.exe",
    "idea64.exe",
    "pycharm64.exe",
    "webstorm64.exe",
    "clion64.exe",
    "goland64.exe",
    "rustrover64.exe",
    "notion.exe",
    "obsidian.exe",
    "typora.exe",
    "notepad.exe",
    "notepad++.exe",
    "winword.exe",
    "excel.exe",
    "powerpnt.exe",
    "outlook.exe",
    "thunderbird.exe"
  ]);

  const entertainmentApps = new Set([
    "spotify.exe",
    "qqmusic.exe",
    "cloudmusic.exe",
    "neteasemusic.exe",
    "potplayermini64.exe",
    "potplayermini.exe",
    "vlc.exe",
    "mpv.exe"
  ]);

  if (focusApps.has(app)) return "focus";
  if (entertainmentApps.has(app)) return "entertainment";

  // Browser heuristics via title keywords (best-effort, avoid leaking the full title to the LLM).
  const isBrowser = app === "chrome.exe" || app === "msedge.exe" || app === "firefox.exe" || app === "brave.exe";
  if (isBrowser) {
    if (title.includes("bilibili") || title.includes("哔哩") || title.includes("b站") || title.includes("youtube")) return "entertainment";
    if (title.includes("微博") || title.includes("weibo") || title.includes("小红书") || title.includes("xhs") || title.includes("twitter") || title.includes("x.com")) return "social";
    if (title.includes("notion") || title.includes("docs") || title.includes("gmail") || title.includes("outlook")) return "focus";
  }

  // Fallback: treat configured social apps elsewhere as "social" via SensorUpdate.socialHits3m/state.
  return "other";
}

/**
 * Analyze text sentiment and pick an appropriate expression.
 * Uses keyword matching for quick, offline sentiment detection.
 */
function analyzeTextSentiment(text: string): ActionCommand["expression"] | null {
  const t = String(text ?? "").toLowerCase();

  // Happy / Excited indicators
  const happyPatterns = [
    /[😊😄😃🥰❤️💕🎉✨]/,
    /哈哈|嘻嘻|太好了|开心|高兴|棒|厉害|赞|好的|没问题|当然|好呀/,
    /great|awesome|wonderful|happy|love|excellent|perfect|amazing/i
  ];
  for (const p of happyPatterns) {
    if (p.test(t)) return "HAPPY";
  }

  // Excited indicators
  const excitedPatterns = [
    /！！|!!|\?!|!？/,
    /太棒了|超级|非常棒|激动|兴奋|哇|wow|woah/i
  ];
  for (const p of excitedPatterns) {
    if (p.test(t)) return "EXCITED";
  }

  // Sad indicators
  const sadPatterns = [
    /[😢😭😞😔💔]/,
    /难过|伤心|抱歉|对不起|遗憾|可惜|不好意思|失败|错误/,
    /sorry|sad|unfortunately|failed|error|problem/i
  ];
  for (const p of sadPatterns) {
    if (p.test(t)) return "SAD";
  }

  // Angry indicators
  const angryPatterns = [
    /[😠😡🤬]/,
    /生气|愤怒|讨厌|烦|不行|不可以|禁止|不允许/,
    /angry|annoyed|frustrated/i
  ];
  for (const p of angryPatterns) {
    if (p.test(t)) return "ANGRY";
  }

  // Surprised indicators
  const surprisedPatterns = [
    /[😲😮😯🤯]/,
    /真的吗|天哪|什么|居然|竟然|不敢相信|没想到/,
    /really|wow|omg|what|surprised|unexpected/i
  ];
  for (const p of surprisedPatterns) {
    if (p.test(t)) return "SURPRISED";
  }

  // Thinking / Confused indicators
  const thinkingPatterns = [
    /[🤔💭]/,
    /让我想想|思考|考虑|不确定|可能|也许|或许|嗯\.\.\./,
    /let me think|thinking|consider|maybe|perhaps|hmm/i
  ];
  for (const p of thinkingPatterns) {
    if (p.test(t)) return "THINKING";
  }

  // Confused indicators
  const confusedPatterns = [
    /[😕🤷]/,
    /不太明白|不理解|有点困惑|什么意思|不懂/,
    /confused|don't understand|unclear/i
  ];
  for (const p of confusedPatterns) {
    if (p.test(t)) return "CONFUSED";
  }

  // Shy indicators
  const shyPatterns = [
    /[😳🙈]/,
    /害羞|不好意思|过奖|谢谢夸奖|客气/
  ];
  for (const p of shyPatterns) {
    if (p.test(t)) return "SHY";
  }

  return null;
}

function pickChatExpression(isNight: boolean, mood: number, replyText?: string): ActionCommand["expression"] {
  // First, try to analyze the reply text for sentiment
  if (replyText) {
    const sentiment = analyzeTextSentiment(replyText);
    if (sentiment) return sentiment;
  }

  // Fallback to mood-based expression
  if (isNight) return "TIRED";
  if (mood < 0.35) return "SAD";
  return "SHY";
}

function parseRememberNote(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  // Explicit, low-ambiguity commands only.
  // Examples:
  // - 记住: 我叫小明
  // - 记一下：我喜欢简洁回答
  // - /remember I prefer short replies
  const m =
    s.match(/^(?:\/remember|\/mem)(?:\s+)(.+)$/i) ??
    s.match(/^(?:请\s*)?(?:记住|记一下|记下来)(?:\s*[:：]|\s+)?(.+)$/);
  if (!m) return null;
  const content = String(m[1] ?? "").trim();
  return content ? content : null;
}

function parseSlashCommand(raw: string): { cmd: string; args: string } | null {
  const s = String(raw ?? "").trim();
  if (!s.startsWith("/")) return null;
  const m = s.slice(1).match(/^([a-zA-Z_-]+)(?:\s+([\s\S]*))?$/);
  if (!m?.[1]) return null;
  const cmd = m[1].toLowerCase();
  const args = String(m[2] ?? "").trim();
  return { cmd, args };
}

function looksSensitiveText(s: string) {
  const t = String(s ?? "");
  if (!t) return false;
  if (/sk-[A-Za-z0-9]{10,}/.test(t)) return true;
  if (/AIza[0-9A-Za-z_-]{10,}/.test(t)) return true;
  if (/(api[_-]?key|password|密码|令牌|token)/i.test(t) && t.length > 20) return true;
  return false;
}

function redactSensitiveForSummary(s: string) {
  const t = String(s ?? "").trim();
  if (!t) return "";
  if (looksSensitiveText(t)) return "[敏感信息已省略]";
  return t;
}

function ruleBasedMemoryExtract(userMsg: string): { kind: "preference" | "profile" | "project" | "note"; content: string }[] {
  const s = String(userMsg ?? "").trim();
  if (!s) return [];
  if (looksSensitiveText(s)) return [];

  const out: { kind: "preference" | "profile" | "project" | "note"; content: string }[] = [];

  // Name patterns (keep conservative).
  const nameMatch =
    s.match(/(?:我叫|我的名字是|名叫)\s*([^\s，,。.!！?？\n]{1,16})/) ?? s.match(/叫我\s*([^\s，,。.!！?？\n]{1,16})/);
  if (nameMatch?.[1]) {
    const name = String(nameMatch[1]).trim();
    if (name && name.length <= 16) out.push({ kind: "profile", content: `用户名字：${name}` });
  }

  // Simple preferences.
  const like = s.match(/我(喜欢|更喜欢|爱)\s*([^。!?？\n]{1,40})/);
  if (like?.[2]) {
    const v = like[2].trim();
    if (v) out.push({ kind: "preference", content: `喜欢：${v}` });
  }
  const dislike = s.match(/我(不喜欢|讨厌|不爱)\s*([^。!?？\n]{1,40})/);
  if (dislike?.[2]) {
    const v = dislike[2].trim();
    if (v) out.push({ kind: "preference", content: `不喜欢：${v}` });
  }

  // De-dup by content.
  const seen = new Set<string>();
  const uniq = out.filter((x) => {
    const key = `${x.kind}|${x.content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return uniq.slice(0, 3);
}

export class CoreService {
  #llm: LLMService;
  #memory: MemoryService;
  #skills: SkillService;
  #enabledSkills: string[] = [];
  #tools: ToolService | null = null;
  #onAction: (cmd: ActionCommand, meta: { proactive: boolean }) => void;
  #onProactiveChat: ((m: { ts: number; content: string }) => void) | null = null;

  #state: CompanionState = "IDLE";
  #lastSensor: SensorUpdate | null = null;
  #activeAppSinceTs = 0;
  #activeAppName = "";
  #activeContextSinceTs = 0;
  #activeContext: "focus" | "entertainment" | "social" | "other" = "other";

  #affection = 0.4;
  #security = 0.5;
  #mood = 0.5;
  #energy = 0.7;

  #dailyKey = "";
  #ignoreStreak = 0;
  #lastProactiveTs = 0;
  #inFlight = false;
  #proactiveLastByKind = new Map<ProactiveSignal["kind"], number>();
  #proactiveOncePerDay = new Set<string>();

  // Session tracking (for "long session" reminders)
  #sessionStartTs: number | null = null;
  #sessionReminded = false;

  // Late-night reminder tracking
  #lateNightLastTs = 0;

  // Random tip: roll once per day (per app session)
  #randomTipRolledDay = "";

  #chatHistory: { role: "user" | "assistant"; content: string }[] = [];
  #summaryInFlight = false;
  #lastSummaryUpdateTs = 0;

  #webSearchEnabled = false;
  #webSearchApiKey = "";
  #webSearchMaxResults = 6;

  setAssistantConfig(cfg: any) {
    const c = cfg && typeof cfg === "object" ? cfg : null;

    const ws = c && typeof (c as any).webSearch === "object" ? (c as any).webSearch : null;
    this.#webSearchEnabled = Boolean(ws?.enabled ?? false);
    this.#webSearchApiKey = typeof ws?.tavilyApiKey === "string" ? ws.tavilyApiKey : "";
    const mr = Math.floor(Number(ws?.maxResults ?? 6) || 0);
    this.#webSearchMaxResults = mr > 0 ? Math.max(1, Math.min(10, mr)) : 6;

    const skills = c && typeof (c as any).skills === "object" ? (c as any).skills : null;
    const dir = typeof skills?.dir === "string" ? skills.dir.trim() : "";
    this.#skills = new SkillService({ skillsDir: dir || undefined });
    const enabled = Array.isArray(skills?.enabled) ? skills.enabled : null;
    if (enabled) {
      this.#enabledSkills = enabled.map((x: any) => String(x ?? "").trim()).filter(Boolean);
    }

    // Tools runtime (for tool_calls execution)
    try {
      this.#tools = new ToolService(c ?? {});
    } catch {
      this.#tools = null;
    }
  }

  constructor(opts: {
    llm: LLMService;
    memory: MemoryService;
    onAction: (cmd: ActionCommand, meta: { proactive: boolean }) => void;
    onProactiveChat?: (m: { ts: number; content: string }) => void;
  }) {
    this.#llm = opts.llm;
    this.#memory = opts.memory;
    this.#onAction = opts.onAction;
    this.#onProactiveChat = typeof opts.onProactiveChat === "function" ? opts.onProactiveChat : null;
    this.#skills = new SkillService();
    this.#tools = null;

    // Optional: enable skills by default via env (comma-separated).
    // (This can be overridden later by `setAssistantConfig()`.)
    const envSkills = String(process.env.SAMA_SKILLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (envSkills.length) this.#enabledSkills = envSkills;

    // Long-term memory v1: persist chat history locally and restore it on boot
    // so conversations continue across restarts.
    try {
      const persisted = this.#memory.getRecentChatHistory(40);
      if (persisted.length) this.#chatHistory = persisted;
    } catch {}
  }

  get state() {
    return this.#state;
  }

  get mood() {
    return this.#mood;
  }

  get isNight() {
    return this.#lastSensor?.isNight ?? false;
  }

  clearChatHistory() {
    this.#chatHistory = [];
  }

  #emitProactiveChat(text: string, ts: number) {
    const content = String(text ?? "").trim();
    if (!content) return;

    // Persist and also keep it in the rolling chat history so the next user reply has context.
    this.#chatHistory.push({ role: "assistant", content });
    this.#chatHistory = this.#chatHistory.slice(-40);
    try {
      this.#memory.logChatMessage({ ts: ts || Date.now(), role: "assistant", content });
    } catch {}

    try {
      this.#onProactiveChat?.({ ts: ts || Date.now(), content });
    } catch {}
  }

  #canFire(kind: ProactiveSignal["kind"], ts: number, opts: { cdMs: number; oncePerDay?: boolean }) {
    const cdMs = Math.max(0, Math.floor(Number(opts.cdMs) || 0));
    const last = this.#proactiveLastByKind.get(kind) ?? 0;
    if (cdMs > 0 && last && ts - last < cdMs) return false;

    if (opts.oncePerDay) {
      const key = `${todayKey(ts)}|${kind}`;
      if (this.#proactiveOncePerDay.has(key)) return false;
    }

    return true;
  }

  #markFired(kind: ProactiveSignal["kind"], ts: number, opts: { oncePerDay?: boolean }) {
    this.#proactiveLastByKind.set(kind, ts);
    if (opts.oncePerDay) this.#proactiveOncePerDay.add(`${todayKey(ts)}|${kind}`);
  }

  async #renderProactiveText(signal: ProactiveSignal) {
    const now = Math.max(1, Math.floor(Number(signal.ts) || Date.now()));

    const base =
      "【主动提醒信号】\n" +
      `- 时间：${formatLocalHm(now) || "(unknown)"}\n`;

    const detail = (() => {
      if (signal.kind === "CLIPBOARD_TIME") return `- 类型：剪贴板（时间/日程）\n- 内容：${String(signal.excerpt ?? "").trim()}`;
      if (signal.kind === "CLIPBOARD_LINK")
        return `- 类型：剪贴板（链接）\n- 链接：${String(signal.url ?? "").trim()}\n- 平台：${String(signal.site ?? "unknown")}`;
      if (signal.kind === "HEALTH_LONG_SESSION") return `- 类型：健康（久坐/护眼）\n- 连续操作：${Math.max(1, Math.floor(signal.minutes || 0))} 分钟`;
      if (signal.kind === "HEALTH_LATE_NIGHT") return `- 类型：健康（深夜作息）\n- 现在：${signal.localTime || formatLocalHm(now)}`;
      if (signal.kind === "SYSTEM_BATTERY")
        return `- 类型：系统（电量提醒）\n- 电量：${Math.max(0, Math.min(100, Math.floor(signal.percent || 0)))}%\n- 充电：${
          signal.charging ? "是" : "否"
        }\n- 阈值：${signal.threshold}%`;
      if (signal.kind === "CONTEXT_FOCUS") return `- 类型：上下文（专注）\n- 应用：${signal.app}`;
      if (signal.kind === "CONTEXT_ENTERTAINMENT") return `- 类型：上下文（娱乐）\n- 应用：${signal.app}`;
      if (signal.kind === "CONTEXT_SOCIAL_FATIGUE") return `- 类型：上下文（社交疲劳）\n- 应用：${signal.app}`;
      return "- 类型：随机灵感";
    })();

    const prompt =
      base +
      detail +
      "\n\n" +
      "请像正常聊天一样，用一到两句中文温柔俏皮地说出来：最好带一个轻问题；不要说教；不要泄露隐私；不要声称你打开了链接或看到了具体内容。\n" +
      "只输出要对用户说的话。";

    // Prefer LLM for style; fallback to a small rule set.
    if (this.#llm.enabled) {
      const text = await this.#llm.generateProactive(
        { state: this.#state, isNight: this.isNight || isLateNight(now), mood: this.#mood },
        prompt,
        80
      );
      if (String(text ?? "").trim()) return String(text).trim();
    }

    // Fallback (offline)
    if (signal.kind === "CLIPBOARD_TIME") return "要我帮你记个提醒吗？";
    if (signal.kind === "CLIPBOARD_LINK") return "要我帮你先收着吗？";
    if (signal.kind === "HEALTH_LONG_SESSION") return "起来喝口水，好嘛？";
    if (signal.kind === "HEALTH_LATE_NIGHT") return "这么晚啦，要歇会吗？";
    if (signal.kind === "SYSTEM_BATTERY") return signal.threshold === 20 ? "电量有点危险啦…" : "电量到50了，要插电吗？";
    if (signal.kind === "CONTEXT_FOCUS") return "我先不吵你，加油！";
    if (signal.kind === "CONTEXT_ENTERTAINMENT") return "在看啥呀，安利我？";
    if (signal.kind === "CONTEXT_SOCIAL_FATIGUE") return "要不要缓一缓呀？";
    return "我在这儿陪你哦。";
  }

  async #fireProactive(signal: ProactiveSignal, cmd: ActionCommand, mark: { oncePerDay?: boolean } = {}) {
    const ts = Math.max(1, Math.floor(Number(signal.ts) || Date.now()));

    // Global cooldown marker (for low-priority chatter). Health reminders bypass `#canProactive` but still
    // should prevent rapid-fire multi-trigger spam.
    this.#lastProactiveTs = ts;
    try {
      this.#memory.incrementProactive(todayKey(ts));
    } catch {}

    try {
      this.#memory.logAction(cmd);
    } catch {}

    this.#onAction(cmd, { proactive: true });
    if (cmd.bubble) this.#emitProactiveChat(cmd.bubble, ts);

    // Mark as fired.
    this.#markFired(signal.kind, ts, mark);
  }

  async handleProactiveSignal(signal: ProactiveSignal): Promise<boolean> {
    const ts = Math.max(1, Math.floor(Number(signal?.ts) || Date.now()));
    const kind = signal?.kind;
    if (!kind) return false;

    if (this.#inFlight) return false;

    // Hard safety: avoid back-to-back spam when many signals arrive at once.
    if (this.#lastProactiveTs && ts - this.#lastProactiveTs < 1200) return false;

    // Decide gating per kind.
    const gate = (() => {
      if (kind === "HEALTH_LONG_SESSION") return { cdMs: 2 * 60 * 60_000, oncePerDay: false };
      if (kind === "HEALTH_LATE_NIGHT") return { cdMs: 2 * 60 * 60_000, oncePerDay: false };
      if (kind === "SYSTEM_BATTERY") return { cdMs: kind === "SYSTEM_BATTERY" && (signal as any).threshold === 20 ? 20 * 60_000 : 45 * 60_000, oncePerDay: false };
      if (kind === "CLIPBOARD_TIME") return { cdMs: 2 * 60_000, oncePerDay: false };
      if (kind === "CLIPBOARD_LINK") return { cdMs: 2 * 60_000, oncePerDay: false };
      if (kind === "CONTEXT_FOCUS") return { cdMs: 15 * 60_000, oncePerDay: false };
      if (kind === "CONTEXT_ENTERTAINMENT") return { cdMs: 20 * 60_000, oncePerDay: false };
      if (kind === "CONTEXT_SOCIAL_FATIGUE") return { cdMs: 12 * 60_000, oncePerDay: false };
      return { cdMs: 4 * 60 * 60_000, oncePerDay: true };
    })();

    // Health reminders are high-priority: don't block on the standard proactive throttle.
    const isHealth = kind === "HEALTH_LONG_SESSION" || kind === "HEALTH_LATE_NIGHT" || kind === "SYSTEM_BATTERY";
    if (!isHealth) {
      if (!this.#canProactive(ts)) return false;
    }

    if (!this.#canFire(kind, ts, gate)) return false;

    const prevInFlight = this.#inFlight;
    this.#inFlight = true;
    try {
      const bubble = await this.#renderProactiveText(signal);
      const cmd: ActionCommand = {
        type: "ACTION_COMMAND",
        ts,
        action:
          kind === "CONTEXT_FOCUS"
            ? "RETREAT"
            : kind === "CONTEXT_SOCIAL_FATIGUE"
              ? "APPROACH"
              : "IDLE",
        expression:
          kind === "HEALTH_LATE_NIGHT"
            ? "TIRED"
            : kind === "SYSTEM_BATTERY"
              ? "THINKING"
              : kind === "CONTEXT_ENTERTAINMENT"
                ? "EXCITED"
                : kind === "CONTEXT_FOCUS"
                  ? "NEUTRAL"
                  : "SHY",
        bubble,
        durationMs: bubbleDurationForText(bubble)
      };

      await this.#fireProactive(signal, cmd, { oncePerDay: gate.oncePerDay });
      return true;
    } finally {
      this.#inFlight = prevInFlight;
    }
  }

  async #maybeUpdateConversationSummary() {
    if (!this.#llm.enabled) return;
    if (!this.#memory.enabled) return;
    if (!this.#memory.getAgentMemoryConfig().summaryEnabled) return;

    const now = Date.now();
    if (this.#summaryInFlight) return;

    // Debounce: if the user is typing quickly, don't fire summary requests too frequently.
    if (this.#lastSummaryUpdateTs && now - this.#lastSummaryUpdateTs < 2500) return;

    this.#summaryInFlight = true;
    try {
      const { summary: currentSummary, summaryJson, lastId } = this.#memory.getConversationSummary();
      const currentSeed = summaryJson ? JSON.stringify(summaryJson) : currentSummary;

      const rows =
        lastId > 0
          ? this.#memory.getChatMessagesSinceId(lastId, 80)
          : this.#memory.getRecentChatMessagesWithIds(80);

      if (!rows.length) return;

      const newMessages = rows
        .map((r) => ({
          role: r.role,
          content: redactSensitiveForSummary(r.content)
        }))
        .filter((m) => m.content);

      // Typical turn is 2 messages (user + assistant). If we have fewer, wait for more.
      if (newMessages.length < 2) return;

      const updated = await this.#llm.summarizeConversation({ currentSummary: currentSeed, newMessages });
      const nextText = String(updated?.summaryText ?? "").trim();
      if (!nextText) return;

      // Never persist potentially sensitive content.
      if (looksSensitiveText(nextText)) return;

      const nextLastId = rows[rows.length - 1]?.id ?? lastId;
      this.#memory.setConversationSummary(nextText, updated?.summaryJson ?? null, nextLastId);
      this.#lastSummaryUpdateTs = now;
    } catch (err) {
      console.warn("[memory] short-term summary skipped:", err);
    } finally {
      this.#summaryInFlight = false;
    }
  }

  async #chatWithTools(
    ctx: {
      state: string;
      isNight: boolean;
      mood: number;
      history: { role: "user" | "assistant"; content: string }[];
      memory?: string;
      summary?: string;
      skills?: string;
      tools?: string;
    },
    userMsg: string,
    allowedTools: Set<string>,
    images?: ChatRequest["images"]
  ) {
    const hasImages = Array.isArray(images) && images.length > 0;

    // If tools are not configured/enabled, behave like a normal chat.
    if (!this.#tools || !allowedTools.size) {
      return this.#llm.chatReply(ctx, hasImages ? { text: userMsg, images: images! } : userMsg);
    }

    const maxRounds = 3;
    const maxCallsPerRound = 6;

    let currentMsg = userMsg;
    let currentImages: ChatRequest["images"] | undefined = hasImages ? images : undefined;
    let toolTranscript = "";

    for (let round = 0; round < maxRounds; round++) {
      const reply = await this.#llm.chatReply(ctx, currentImages ? { text: currentMsg, images: currentImages } : currentMsg);
      currentImages = undefined; // Only include images on the first round.
      const parsed = parseToolCalls(reply);
      if (!parsed.hasToolCalls) return reply;

      const calls = parsed.toolCalls.slice(0, maxCallsPerRound);
      const results: { name: string; ok: boolean; content: string }[] = [];

      for (const c of calls) {
        const name = String(c?.name ?? "").trim();
        if (!name) continue;

        if (!allowedTools.has(name)) {
          results.push({ name, ok: false, content: `Tool not allowed for this message: ${name}` });
          continue;
        }

        try {
          const r = await this.#tools.run({ name, arguments: c.arguments ?? {} });
          results.push({ name: r.name, ok: r.ok, content: r.content });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ name, ok: false, content: `Tool failed: ${msg}` });
        }
      }

      const block = formatToolResults(results).trim();
      toolTranscript = toolTranscript ? `${toolTranscript}\n\n${block}` : block;

      // Feed tool results back to the model. It may either answer directly or request more tools.
      currentMsg =
        `用户问题：\n${userMsg}\n\n` +
        `${toolTranscript}\n\n` +
        "请基于工具执行结果继续：\n" +
        "- 若还需要调用工具，请按工具调用格式输出 tool_calls。\n" +
        "- 否则请直接给出最终回答（不要再输出 tool_calls）。";
    }

    // Too many rounds; return a helpful message rather than looping forever.
    return (
      "我尝试调用工具以完成你的请求，但工具调用轮次达到上限，未能得到最终回答。\n\n" +
      (toolTranscript ? `${toolTranscript}\n\n` : "") +
      "你可以：\n- 减少一次请求里要做的事情\n- 或在工具选择里只勾选必要的 1-2 个工具/skills 再试一次"
    );
  }

  #recomputeState(u: SensorUpdate): CompanionState {
    // Priority order from spec
    if (u.idleSec >= 180) return "IDLE";
    if (u.socialHits3m >= 3 && u.switchRate2m >= 6) return "SOCIAL_CHECK_LOOP";
    if (u.switchRate2m >= 10) return "FRAGMENTED";

    const sameAppForMs =
      u.activeApp === this.#activeAppName ? Math.max(0, u.ts - this.#activeAppSinceTs) : 0;
    if (u.switchRate2m < 3 && u.idleSec < 60 && sameAppForMs >= 180_000) return "FOCUS";

    return "IDLE";
  }

  #tickEmotions(u: SensorUpdate) {
    if (u.isNight) {
      this.#energy = clamp01(this.#energy - 0.02);
      this.#affection = clamp01(this.#affection + 0.01);
    }
  }

  #cooldownSecWithBackoff() {
    const base = 300;
    if (this.#ignoreStreak === 1) return base * 1.5;
    if (this.#ignoreStreak === 2) return base * 2.5;
    if (this.#ignoreStreak >= 3) return Number.POSITIVE_INFINITY;
    return base;
  }

  #canProactive(now: number) {
    const day = todayKey(now);
    if (this.#dailyKey !== day) {
      this.#dailyKey = day;
      this.#ignoreStreak = 0;
      this.#lastProactiveTs = 0;
    }

    const stats = this.#memory.getDaily(day);
    if (stats.proactive_count >= 12) return false;
    if (this.#ignoreStreak >= 3) return false;

    const cd = this.#cooldownSecWithBackoff() * 1000;
    if (this.#lastProactiveTs && now - this.#lastProactiveTs < cd) return false;
    return true;
  }

  async handleSensorUpdate(u: SensorUpdate) {
    this.#lastSensor = u;

    if (u.activeApp !== this.#activeAppName) {
      this.#activeAppName = u.activeApp;
      this.#activeAppSinceTs = u.ts;
    }

    this.#tickEmotions(u);

    const prev = this.#state;
    this.#state = this.#recomputeState(u);
    if (prev !== this.#state) {
      console.log(
        `[core] state ${prev} -> ${this.#state} (switch2m=${u.switchRate2m}, social3m=${u.socialHits3m}, idle=${u.idleSec})`
      );
    }

    const now = u.ts;

    // Context tracking (best-effort, mostly via app name; avoid leaking titles).
    const nextCtx = classifyContext(u.activeApp, u.activeTitle);
    if (nextCtx !== this.#activeContext) {
      this.#activeContext = nextCtx;
      this.#activeContextSinceTs = now;
    }

    // Session tracking: reset after a "real break", start when user becomes active.
    const idleSec = Math.max(0, Math.floor(Number(u.idleSec) || 0));
    if (idleSec >= 300) {
      this.#sessionStartTs = null;
      this.#sessionReminded = false;
    } else if (this.#sessionStartTs === null && idleSec < 30) {
      this.#sessionStartTs = now;
      this.#sessionReminded = false;
    }

    // 1) Health: long session (> 60min) + user still active.
    if (this.#sessionStartTs !== null && !this.#sessionReminded && idleSec < 60) {
      const sessionMs = Math.max(0, now - this.#sessionStartTs);
      if (sessionMs >= 60 * 60_000) {
        const minutes = Math.max(60, Math.floor(sessionMs / 60_000));
        const ok = await this.handleProactiveSignal({ kind: "HEALTH_LONG_SESSION", ts: now, minutes });
        if (ok) this.#sessionReminded = true;
      }
    }

    // 2) Health: late night (>23:30 or <06:00) + user still active (frequent ops).
    if (isLateNight(now) && idleSec < 60 && Math.max(0, Math.floor(Number(u.switchRate2m) || 0)) >= 2) {
      await this.handleProactiveSignal({ kind: "HEALTH_LATE_NIGHT", ts: now, localTime: formatLocalHm(now) });
    }

    // 3) Process observation / context cues (low frequency, best-effort).
    if (this.#activeContext === "focus" && this.#state === "FOCUS" && idleSec < 60) {
      const inCtxMs = Math.max(0, now - this.#activeContextSinceTs);
      if (inCtxMs >= 3 * 60_000) {
        await this.handleProactiveSignal({ kind: "CONTEXT_FOCUS", ts: now, app: normalizeAppName(u.activeApp) });
      }
    }

    if (this.#activeContext === "entertainment" && idleSec < 120) {
      const inCtxMs = Math.max(0, now - this.#activeContextSinceTs);
      if (inCtxMs >= 45_000) {
        await this.handleProactiveSignal({ kind: "CONTEXT_ENTERTAINMENT", ts: now, app: normalizeAppName(u.activeApp) });
      }
    }

    if (this.#state === "SOCIAL_CHECK_LOOP" && idleSec < 90) {
      // Only hint when the "social loop" pattern is detected, so it's less likely to be a false positive.
      await this.handleProactiveSignal({ kind: "CONTEXT_SOCIAL_FATIGUE", ts: now, app: normalizeAppName(u.activeApp) });
    }

    // 4) Random tiny chance per day (very low priority).
    const day = todayKey(now);
    if (this.#randomTipRolledDay !== day && this.#state === "IDLE" && idleSec < 60) {
      this.#randomTipRolledDay = day;
      if (Math.random() < 0.01) {
        await this.handleProactiveSignal({ kind: "RANDOM_TIP", ts: now });
      }
    }

    // Proactive decision (throttled): movement/bubble behaviors.
    if (!this.#canProactive(now)) return;
    if (this.#inFlight) return;

    const candidate = await this.#decideProactive(u);
    if (!candidate) return;

    this.#lastProactiveTs = now;
    this.#memory.incrementProactive(todayKey(now));
    this.#memory.logAction(candidate);
    this.#onAction(candidate, { proactive: true });

    if (candidate.bubble) this.#emitProactiveChat(candidate.bubble, now);
  }

  async #decideProactive(u: SensorUpdate): Promise<ActionCommand | null> {
    if (this.#ignoreStreak >= 2) {
      return {
        type: "ACTION_COMMAND",
        ts: u.ts,
        action: "RETREAT",
        expression: "SAD",
        bubble: null,
        durationMs: 1500
      };
    }

    if (this.#state === "FOCUS") {
      return {
        type: "ACTION_COMMAND",
        ts: u.ts,
        action: "RETREAT",
        expression: "NEUTRAL",
        bubble: null,
        durationMs: 1500
      };
    }

    if (this.#state === "FRAGMENTED") {
      // low frequency: only occasionally (energy gating)
      if (this.#energy < 0.25) return null;
      return {
        type: "ACTION_COMMAND",
        ts: u.ts,
        action: "APPROACH",
        expression: pickApproachExpression(this.#state, u.isNight),
        bubble: null,
        durationMs: 1500
      };
    }

    if (this.#state === "SOCIAL_CHECK_LOOP") {
      this.#inFlight = true;
      try {
        const bubble = await this.#llm.generateBubble({
          state: this.#state,
          isNight: u.isNight,
          mood: this.#mood
        });
        return {
          type: "ACTION_COMMAND",
          ts: u.ts,
          action: "APPROACH",
          expression: pickApproachExpression(this.#state, u.isNight),
          bubble,
          durationMs: 3000
        };
      } finally {
        this.#inFlight = false;
      }
    }

    // IDLE (CALM): sometimes invite chat
    if (this.#state === "IDLE") {
      const invite = this.#affection > 0.7 && this.#security > 0.6 && this.#energy > 0.3;
      if (!invite) return null;

      return {
        type: "ACTION_COMMAND",
        ts: u.ts,
        action: "INVITE_CHAT",
        expression: u.isNight ? "TIRED" : "SHY",
        bubble: u.isNight ? "要不要早点休息…" : "要不要聊两句？",
        durationMs: 3000
      };
    }

    return null;
  }

  handleUserInteraction(i: UserInteraction) {
    this.#memory.logInteraction(i);

    if (i.event === "CLICK_PET") {
      this.#security = clamp01(this.#security + 0.08);
      this.#mood = clamp01(this.#mood + 0.08);

      const now = i.ts;
      const happy: ActionCommand = {
        type: "ACTION_COMMAND",
        ts: now,
        action: "IDLE",
        expression: "HAPPY",
        bubble: null,
        durationMs: 2000
      };
      this.#memory.logAction(happy);
      this.#onAction(happy, { proactive: false });

      const neutral: ActionCommand = {
        type: "ACTION_COMMAND",
        ts: now + 2000,
        action: "IDLE",
        expression: "NEUTRAL",
        bubble: null,
        durationMs: 0
      };
      setTimeout(() => {
        this.#memory.logAction(neutral);
        this.#onAction(neutral, { proactive: false });
      }, 2000);
      return;
    }

    if (i.event === "IGNORED_ACTION") {
      if (i.action === "APPROACH" || i.action === "INVITE_CHAT") {
        this.#ignoreStreak += 1;
        this.#security = clamp01(this.#security - 0.08);
        this.#mood = clamp01(this.#mood - 0.05);
        this.#memory.incrementIgnore(todayKey(i.ts));

        if (this.#ignoreStreak >= 2) {
          const retreat: ActionCommand = {
            type: "ACTION_COMMAND",
            ts: i.ts,
            action: "RETREAT",
            expression: "SAD",
            bubble: null,
            durationMs: 1500
          };
          this.#memory.logAction(retreat);
          this.#onAction(retreat, { proactive: false });
        }
      }
    }
  }

  async handleChat(req: ChatRequest): Promise<ChatResponse> {
    const hasImages = Array.isArray(req.images) && req.images.length > 0;
    const userTextForHistory = String(req.message ?? "").trim() ? String(req.message ?? "") : hasImages ? "（用户发送了图片）" : "";

    // Persist user message before LLM call so it survives crashes/restarts.
    try {
      this.#memory.logChatMessage({ ts: req.ts, role: "user", content: userTextForHistory });
    } catch {}

    // Agent commands (memory introspection / maintenance).
    const slash = parseSlashCommand(req.message);
    if (slash) {
      const replyTs = Date.now();

      const respond = (message: string) => {
        this.#chatHistory.push({ role: "user", content: req.message });
        this.#chatHistory.push({ role: "assistant", content: message });
        this.#chatHistory = this.#chatHistory.slice(-40);
        try {
          this.#memory.logChatMessage({ ts: replyTs, role: "assistant", content: message });
        } catch {}
        return { type: "CHAT_RESPONSE" as const, ts: replyTs, message };
      };

      const cfg = this.#memory.getAgentMemoryConfig();

      if (slash.cmd === "search" || slash.cmd === "websearch") {
        const q = slash.args.trim();
        if (!q) return respond("用法：/search <query>");
        try {
          if (!this.#webSearchEnabled) return respond("联网搜索未启用：请在 LLM 面板开启 Web Search。");
          const apiKey = String(this.#webSearchApiKey || process.env.TAVILY_API_KEY || "").trim();
          if (!apiKey) return respond("未配置 Tavily API Key：请在 LLM 面板填写（或设置环境变量 TAVILY_API_KEY）。");

          const results = await webSearch(q, { apiKey, maxResults: this.#webSearchMaxResults, timeoutMs: 12_000 });
          if (!results.length) return respond("（没有搜到结果）");
          const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet || ""}`.trim());
          return respond(`【联网搜索结果】\n\n${lines.join("\n\n")}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (String(msg).includes("missing TAVILY_API_KEY")) {
            return respond("未配置联网搜索：请在 LLM 面板填写 Tavily API Key（或设置环境变量 TAVILY_API_KEY）。");
          }
          return respond(`联网搜索失败：${msg}`);
        }
      }

      if (slash.cmd === "web" || slash.cmd === "browse") {
        const q = slash.args.trim();
        if (!q) return respond("用法：/web <query>\n说明：先联网搜索，再让 LLM 基于结果回答。");

        let results: { title: string; url: string; snippet: string }[] = [];
        try {
          if (!this.#webSearchEnabled) return respond("联网搜索未启用：请在 LLM 面板开启 Web Search。");
          const apiKey = String(this.#webSearchApiKey || process.env.TAVILY_API_KEY || "").trim();
          if (!apiKey) return respond("未配置 Tavily API Key：请在 LLM 面板填写（或设置环境变量 TAVILY_API_KEY）。");

          results = await webSearch(q, { apiKey, maxResults: this.#webSearchMaxResults, timeoutMs: 12_000 });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (String(msg).includes("missing TAVILY_API_KEY")) {
            return respond("未配置联网搜索：请在 LLM 面板填写 Tavily API Key（或设置环境变量 TAVILY_API_KEY）。");
          }
          return respond(`联网搜索失败：${msg}`);
        }

        const webBlock = results.length
          ? results
              .map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet || ""}`.trim())
              .join("\n\n")
          : "（没有搜到结果）";

        const summary = this.#memory.getConversationSummary().summary;
        const ctx = {
          state: this.#state,
          isNight: this.#lastSensor?.isNight ?? false,
          mood: this.#mood,
          history: this.#chatHistory,
          memory: "",
          summary,
          skills: this.#skills.renderSkillsPrompt(this.#enabledSkills),
          tools: ""
        };

        const userMsg =
          "请基于以下【联网搜索结果】回答用户问题；若结论依赖某条信息，请在句末用括号附上对应 URL。\n\n" +
          `【用户问题】\n${q}\n\n` +
          `【联网搜索结果】\n${webBlock}\n`;

        const reply = await this.#llm.chatReply(ctx as any, userMsg);
        return respond(reply);
      }

      if (slash.cmd === "skill" || slash.cmd === "skills") {
        const a = slash.args.trim();
        const lower = a.toLowerCase();
        if (!a || lower === "list") {
          const skills = this.#skills.listSkills();
          if (!skills.length) return respond(`未发现 skills。\n路径：${this.#skills.skillsDir}`);
          const enabled = new Set(this.#enabledSkills);
          const lines = skills.map((s) => `${enabled.has(s.name) ? "✓" : "-"} ${s.name}`);
          return respond(`Skills（路径：${this.#skills.skillsDir}）\n\n${lines.join("\n")}\n\n用法：/skill use <name> | /skill off | /skill show`);
        }
        if (lower === "off" || lower === "clear" || lower === "reset") {
          this.#enabledSkills = [];
          return respond("已关闭所有 skills（仅影响后续对话）。");
        }
        if (lower === "show") {
          return respond(this.#enabledSkills.length ? `已启用：${this.#enabledSkills.join(", ")}` : "（当前未启用任何 skill）");
        }
        if (lower.startsWith("use ")) {
          const name = a.slice("use ".length).trim();
          if (!name) return respond("用法：/skill use <name>");
          const exists = this.#skills.listSkills().some((s) => s.name === name);
          if (!exists) return respond(`未找到 skill：「${name}」\n用 /skill list 查看可用列表。`);
          const set = new Set(this.#enabledSkills);
          set.add(name);
          this.#enabledSkills = Array.from(set);
          return respond(`已启用 skill：「${name}」（仅影响后续对话）。`);
        }
        return respond("用法：/skill list | /skill use <name> | /skill off | /skill show");
      }

      if (slash.cmd === "summary" || slash.cmd === "sum") {
        const a = slash.args.toLowerCase();
        if (a === "clear" || a === "reset") {
          if (!this.#memory.enabled) return respond("本地记忆未启用（SQLite 不可用），无法清空短期摘要。");
          this.#memory.clearConversationSummary();
          return respond("已清空短期摘要（working memory）。");
        }

        const s = this.#memory.getConversationSummary().summary;
        return respond(s ? `短期摘要（working memory）：\n\n${s}` : "（暂无短期摘要）");
      }

      if (slash.cmd === "memory" || slash.cmd === "mem") {
        const a = slash.args.trim();
        const lower = a.toLowerCase();
        if (lower.startsWith("search ")) {
          const q = a.slice("search ".length).trim();
          const prompt = this.#memory.getMemoryPromptForQuery(q, cfg.injectLimit || 12);
          return respond(prompt ? `相关长期记忆：\n\n${prompt}` : "（未找到相关长期记忆）");
        }

        if (lower === "clear all") {
          if (!this.#memory.enabled) return respond("本地记忆未启用（SQLite 不可用），无法清空。");
          this.#memory.clearMemoryNotes();
          this.#memory.clearMemoryFacts();
          return respond("已清空长期记忆（facts + notes）。");
        }
        if (lower === "clear notes") {
          if (!this.#memory.enabled) return respond("本地记忆未启用（SQLite 不可用），无法清空。");
          this.#memory.clearMemoryNotes();
          return respond("已清空长期记忆 notes。");
        }
        if (lower === "clear facts") {
          if (!this.#memory.enabled) return respond("本地记忆未启用（SQLite 不可用），无法清空。");
          this.#memory.clearMemoryFacts();
          return respond("已清空长期记忆 facts。");
        }

        const facts = this.#memory.listMemoryFacts(10);
        const notes = this.#memory.listMemoryNotes(10);
        const lines: string[] = [];
        lines.push(`长期记忆状态：${this.#memory.enabled ? "Enabled" : "Off"}`);
        if (facts.length) {
          lines.push("\n【Facts】");
          for (const f of facts) lines.push(`- #${f.id} ${f.key}: ${f.value}`);
        } else {
          lines.push("\n【Facts】\n- （空）");
        }
        if (notes.length) {
          lines.push("\n【Notes】");
          for (const n of notes) lines.push(`- #${n.id} (${n.kind}) ${n.content}`);
        } else {
          lines.push("\n【Notes】\n- （空）");
        }
        lines.push("\n用法：/summary | /summary clear | /search <query> | /web <query> | /skill list | /memory search <query> | /memory clear notes|facts|all | /forget note <id> | /forget fact <id>");
        return respond(lines.join("\n").trim());
      }

      if (slash.cmd === "forget" || slash.cmd === "del") {
        const parts = slash.args.trim().split(/\s+/g);
        const kind = String(parts[0] ?? "").toLowerCase();
        const id = Math.floor(Number(parts[1] ?? 0) || 0);
        if (!this.#memory.enabled) return respond("本地记忆未启用（SQLite 不可用），无法删除。");
        if (!id) return respond("用法：/forget note <id> 或 /forget fact <id>");

        if (kind === "note" || kind === "notes") {
          const ok = this.#memory.deleteMemoryNoteById(id);
          return respond(ok ? `已忘掉 note #${id}` : `未找到 note #${id}（或删除失败）`);
        }
        if (kind === "fact" || kind === "facts") {
          const ok = this.#memory.deleteMemoryFactById(id);
          return respond(ok ? `已忘掉 fact #${id}` : `未找到 fact #${id}（或删除失败）`);
        }
        return respond("用法：/forget note <id> 或 /forget fact <id>");
      }
    }

    // Long-term memory (manual): let users explicitly store durable notes.
    const remember = parseRememberNote(req.message);
    if (remember) {
      if (looksSensitiveText(remember)) {
        const reply = "出于安全考虑，我不会把看起来像密码/API Key/token 的内容写入长期记忆。";
        const replyTs = Date.now();

        this.#chatHistory.push({ role: "user", content: req.message });
        this.#chatHistory.push({ role: "assistant", content: reply });
        this.#chatHistory = this.#chatHistory.slice(-40);

        try {
          this.#memory.logChatMessage({ ts: replyTs, role: "assistant", content: reply });
        } catch {}

        const bubble = normalizeBubbleText(pickBubbleTextFromReply(reply));
        const cmd: ActionCommand = {
          type: "ACTION_COMMAND",
          ts: replyTs,
          action: "IDLE",
          expression: pickChatExpression(this.isNight, this.#mood, reply),
          bubbleKind: "text",
          bubble,
          durationMs: bubbleDurationForText(bubble)
        };
        this.#memory.logAction(cmd);
        this.#onAction(cmd, { proactive: false });

        return { type: "CHAT_RESPONSE", ts: replyTs, message: reply };
      }

      const ok = this.#memory.upsertMemoryNote({ kind: "note", content: remember, ts: req.ts });
      const reply = ok
        ? `好，我记住了：${remember}`
        : "我现在无法写入长期记忆（本地记忆存储不可用）。";
      const replyTs = Date.now();

      this.#chatHistory.push({ role: "user", content: req.message });
      this.#chatHistory.push({ role: "assistant", content: reply });
      this.#chatHistory = this.#chatHistory.slice(-40);

      try {
        this.#memory.logChatMessage({ ts: replyTs, role: "assistant", content: reply });
      } catch {}

      const bubble = normalizeBubbleText(pickBubbleTextFromReply(reply));
      const cmd: ActionCommand = {
        type: "ACTION_COMMAND",
        ts: replyTs,
        action: "IDLE",
        expression: pickChatExpression(this.isNight, this.#mood, reply),
        bubbleKind: "text",
        bubble,
        durationMs: bubbleDurationForText(bubble)
      };
      this.#memory.logAction(cmd);
      this.#onAction(cmd, { proactive: false });

      return { type: "CHAT_RESPONSE", ts: replyTs, message: reply };
    }

    const memCfg = this.#memory.getAgentMemoryConfig();
    let memoryPrompt = "";
    if (memCfg.injectLimit > 0) {
      const limit = memCfg.injectLimit;

      const candidateFactsAll = this.#memory.getRelevantMemoryFacts(req.message, Math.min(30, limit * 3));
      const candidateNotesAll = this.#memory.getRelevantMemoryNotes(req.message, Math.min(80, limit * 5));

      // Safety: never send sensitive text to the model via memory injection (or rerank prompt).
      const candidateFacts = candidateFactsAll.filter((f) => !looksSensitiveText(f.key) && !looksSensitiveText(f.value));
      const candidateNotes = candidateNotesAll.filter((n) => !looksSensitiveText(n.content));

      const factBudget = Math.min(10, Math.max(2, Math.round(limit * 0.35)));
      const noteBudget = Math.max(0, limit - factBudget);

      // Fast baseline: keyword relevance (already sorted by our scorer).
      memoryPrompt = this.#memory.formatMemoryPrompt({
        facts: candidateFacts.slice(0, factBudget),
        notes: candidateNotes.slice(0, noteBudget),
        mode: "model"
      });

      // Best-practice: optional LLM re-rank for higher precision.
      // This costs an extra LLM call but significantly reduces "random" memory injection.
      if (memCfg.llmRerank && this.#llm.enabled && this.#memory.enabled) {
        try {
          // Only rerank when we actually have something to choose from.
          if (candidateFacts.length + candidateNotes.length > limit) {
            const ranked = await this.#llm.rerankMemory({
              query: req.message,
              limit,
              facts: candidateFacts.map((f) => ({ id: f.id, kind: f.kind, key: f.key, value: f.value })),
              notes: candidateNotes.map((n) => ({ id: n.id, kind: n.kind, content: n.content }))
            });

            if (ranked) {
              const selectedFacts = ranked.factIds
                .map((id) => candidateFacts.find((f) => f.id === id))
                .filter(Boolean) as typeof candidateFacts;
              const selectedNotes = ranked.noteIds
                .map((id) => candidateNotes.find((n) => n.id === id))
                .filter(Boolean) as typeof candidateNotes;

              // Hard cap to injectLimit.
              const combined = [
                ...selectedFacts.map((x) => ({ t: "f" as const, x })),
                ...selectedNotes.map((x) => ({ t: "n" as const, x }))
              ];
              const clipped = combined.slice(0, limit);
              const facts = clipped.filter((c) => c.t === "f").map((c) => c.x);
              const notes = clipped.filter((c) => c.t === "n").map((c) => c.x);
              memoryPrompt = this.#memory.formatMemoryPrompt({ facts, notes, mode: "model" });
            }
          }
        } catch (err) {
          console.warn("[memory] rerank skipped:", err);
        }
      }
    }
      const summary = this.#memory.getConversationSummary().summary;

      const metaSkills = Array.isArray((req as any)?.meta?.skills) ? (req as any).meta.skills : null;
      const activeSkills = metaSkills
        ? metaSkills.map((x: any) => String(x ?? "").trim()).filter(Boolean)
        : this.#enabledSkills;
      const skillsPrompt = this.#skills.renderSkillsPrompt(activeSkills);

      const metaTools = Array.isArray((req as any)?.meta?.tools) ? (req as any).meta.tools : null;
      const allowlist = metaTools ? metaTools.map((x: any) => String(x ?? "").trim()).filter(Boolean) : undefined;
      const allowedTools = this.#tools ? this.#tools.getAllowedTools({ allowlist }) : new Set<string>();
      const toolsPrompt = allowedTools.size ? renderToolDocs(allowedTools) : "";

      const ctx = {
        state: this.#state,
        isNight: this.#lastSensor?.isNight ?? false,
        mood: this.#mood,
        history: this.#chatHistory,
        memory: memoryPrompt,
        summary,
        skills: skillsPrompt,
        tools: toolsPrompt
      };

    // UX: show an immediate "thinking" indicator near the avatar so users get feedback
    // even if the LLM takes time. The reply bubble will replace it automatically.
    if (this.#llm.enabled) {
      const thinking: ActionCommand = {
        type: "ACTION_COMMAND",
        ts: Date.now(),
        action: "IDLE",
        expression: ctx.isNight ? "TIRED" : "NEUTRAL",
        bubbleKind: "thinking",
        bubble: null,
        durationMs: 25_000
      };
      this.#memory.logAction(thinking);
      this.#onAction(thinking, { proactive: false });
    }

    const reply = await this.#chatWithTools(ctx, userTextForHistory, allowedTools, req.images);
    const replyTs = Date.now();

    this.#chatHistory.push({ role: "user", content: userTextForHistory });
    this.#chatHistory.push({ role: "assistant", content: reply });
    this.#chatHistory = this.#chatHistory.slice(-40);

    try {
      this.#memory.logChatMessage({ ts: replyTs, role: "assistant", content: reply });
    } catch {}

    // Chat reply is rendered as a bubble near the character (separate from the input UI).
    const bubble = normalizeBubbleText(pickBubbleTextFromReply(reply));
    const cmd: ActionCommand = {
      type: "ACTION_COMMAND",
      ts: replyTs,
      action: "IDLE",
      expression: pickChatExpression(ctx.isNight, ctx.mood, reply),
      bubbleKind: "text",
      bubble,
      durationMs: bubbleDurationForText(bubble)
    };
    this.#memory.logAction(cmd);
    this.#onAction(cmd, { proactive: false });

    // Agent-like memory: update short-term summary + optionally extract durable notes in the background.
    // Do NOT block the user-visible reply on this.
    void (async () => {
      await this.#maybeUpdateConversationSummary();

      const cfg = this.#memory.getAgentMemoryConfig();
      if (!cfg.autoRemember) return;
      if (!this.#memory.enabled) return;
      if (looksSensitiveText(req.message) || looksSensitiveText(reply)) return;

      let items: {
        kind: "preference" | "profile" | "project" | "note";
        content?: string;
        key?: string;
        value?: string;
      }[] = [];

      if (cfg.autoMode === "llm") {
        if (!this.#llm.enabled) return;
        items = await this.#llm.extractMemoryNotes(ctx, { user: req.message, assistant: reply });
      } else {
        items = ruleBasedMemoryExtract(req.message) as any;
      }

      for (const it of items) {
        try {
          let key = String((it as any)?.key ?? "").trim();
          let value = String((it as any)?.value ?? "").trim();
          let content = String((it as any)?.content ?? "").trim();

          if (key && value) {
            const keyClean = key.replace(/\s+/g, "").trim();
            const keyLooksValid = keyClean.length <= 80 && /^[a-zA-Z0-9_.:-]+$/.test(keyClean);
            if (keyLooksValid) this.#memory.upsertMemoryFact({ kind: it.kind, key: keyClean, value, ts: replyTs });
            else this.#memory.upsertMemoryNote({ kind: it.kind, content: `${key}: ${value}`, ts: replyTs });
          } else if (content) {
            this.#memory.upsertMemoryNote({ kind: it.kind, content, ts: replyTs });
          }
        } catch {}
      }
    })();

    return { type: "CHAT_RESPONSE", ts: replyTs, message: reply };
  }
}
