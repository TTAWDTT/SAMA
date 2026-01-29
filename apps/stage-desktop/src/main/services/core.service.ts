import type { ActionCommand, ChatRequest, ChatResponse, SensorUpdate, UserInteraction } from "@sama/shared";
import type { CompanionState } from "../protocol/types";
import { LLMService } from "./llm.service";
import { MemoryService } from "./memory.service";

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

function pickApproachExpression(state: CompanionState, isNight: boolean): ActionCommand["expression"] {
  if (state === "SOCIAL_CHECK_LOOP") return isNight ? "TIRED" : "SHY";
  return isNight ? "TIRED" : "NEUTRAL";
}

function truncateByCodepoints(s: string, max: number) {
  const arr = Array.from(String(s ?? "").trim());
  if (arr.length <= max) return arr.join("");
  return arr.slice(0, max).join("") + "…";
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

function pickChatExpression(isNight: boolean, mood: number): ActionCommand["expression"] {
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
  const m = s.match(/^(?:\/remember|\/mem|记住|记一下|记下来)(?:\s*[:：]|\s+)(.+)$/i);
  if (!m) return null;
  const content = String(m[1] ?? "").trim();
  return content ? content : null;
}

function looksSensitiveText(s: string) {
  const t = String(s ?? "");
  if (!t) return false;
  if (/sk-[A-Za-z0-9]{10,}/.test(t)) return true;
  if (/AIza[0-9A-Za-z_-]{10,}/.test(t)) return true;
  if (/(api[_-]?key|password|密码|令牌|token)/i.test(t) && t.length > 20) return true;
  return false;
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
  #onAction: (cmd: ActionCommand, meta: { proactive: boolean }) => void;

  #state: CompanionState = "IDLE";
  #lastSensor: SensorUpdate | null = null;
  #activeAppSinceTs = 0;
  #activeAppName = "";

  #affection = 0.4;
  #security = 0.5;
  #mood = 0.5;
  #energy = 0.7;

  #dailyKey = "";
  #ignoreStreak = 0;
  #lastProactiveTs = 0;
  #inFlight = false;

  #chatHistory: { role: "user" | "assistant"; content: string }[] = [];

  constructor(opts: {
    llm: LLMService;
    memory: MemoryService;
    onAction: (cmd: ActionCommand, meta: { proactive: boolean }) => void;
  }) {
    this.#llm = opts.llm;
    this.#memory = opts.memory;
    this.#onAction = opts.onAction;

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

    // Proactive decision (throttled)
    const now = u.ts;
    if (!this.#canProactive(now)) return;
    if (this.#inFlight) return;

    const candidate = await this.#decideProactive(u);
    if (!candidate) return;

    this.#lastProactiveTs = now;
    this.#memory.incrementProactive(todayKey(now));
    this.#memory.logAction(candidate);
    this.#onAction(candidate, { proactive: true });
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
    // Persist user message before LLM call so it survives crashes/restarts.
    try {
      this.#memory.logChatMessage({ ts: req.ts, role: "user", content: req.message });
    } catch {}

    // Long-term memory (manual): let users explicitly store durable notes.
    const remember = parseRememberNote(req.message);
    if (remember) {
      const ok = this.#memory.upsertMemoryNote({ kind: "note", content: remember, ts: req.ts });
      const reply = ok
        ? `好，我记住了：${remember}`
        : "我现在无法写入长期记忆（本地 SQLite 不可用）。";
      const replyTs = Date.now();

      this.#chatHistory.push({ role: "user", content: req.message });
      this.#chatHistory.push({ role: "assistant", content: reply });
      this.#chatHistory = this.#chatHistory.slice(-40);

      try {
        this.#memory.logChatMessage({ ts: replyTs, role: "assistant", content: reply });
      } catch {}

      const bubble = truncateByCodepoints(normalizeBubbleText(pickBubbleTextFromReply(reply)), 180);
      const cmd: ActionCommand = {
        type: "ACTION_COMMAND",
        ts: replyTs,
        action: "IDLE",
        expression: pickChatExpression(this.isNight, this.#mood),
        bubbleKind: "text",
        bubble,
        durationMs: bubbleDurationForText(bubble)
      };
      this.#memory.logAction(cmd);
      this.#onAction(cmd, { proactive: false });

      return { type: "CHAT_RESPONSE", ts: replyTs, message: reply };
    }

    const memCfg = this.#memory.getAgentMemoryConfig();
    const memoryPrompt = memCfg.injectLimit > 0 ? this.#memory.getMemoryPrompt(memCfg.injectLimit) : "";

    const ctx = {
      state: this.#state,
      isNight: this.#lastSensor?.isNight ?? false,
      mood: this.#mood,
      history: this.#chatHistory,
      memory: memoryPrompt
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

    const reply = await this.#llm.chatReply(ctx, req.message);
    const replyTs = Date.now();

    this.#chatHistory.push({ role: "user", content: req.message });
    this.#chatHistory.push({ role: "assistant", content: reply });
    this.#chatHistory = this.#chatHistory.slice(-40);

    try {
      this.#memory.logChatMessage({ ts: replyTs, role: "assistant", content: reply });
    } catch {}

    // Chat reply is rendered as a bubble near the character (separate from the input UI).
    const bubble = truncateByCodepoints(normalizeBubbleText(pickBubbleTextFromReply(reply)), 180);
    const cmd: ActionCommand = {
      type: "ACTION_COMMAND",
      ts: replyTs,
      action: "IDLE",
      expression: pickChatExpression(ctx.isNight, ctx.mood),
      bubbleKind: "text",
      bubble,
      durationMs: bubbleDurationForText(bubble)
    };
    this.#memory.logAction(cmd);
    this.#onAction(cmd, { proactive: false });

    // Agent-like memory: optionally extract durable notes in the background.
    // Do NOT block the user-visible reply on this.
    void (async () => {
      const cfg = this.#memory.getAgentMemoryConfig();
      if (!cfg.autoRemember) return;
      if (!this.#memory.enabled) return;
      if (looksSensitiveText(req.message) || looksSensitiveText(reply)) return;

      const items =
        cfg.autoMode === "llm" && this.#llm.enabled
          ? await this.#llm.extractMemoryNotes(ctx, { user: req.message, assistant: reply })
          : ruleBasedMemoryExtract(req.message);

      for (const it of items) {
        try {
          this.#memory.upsertMemoryNote({ kind: it.kind, content: it.content, ts: replyTs });
        } catch {}
      }
    })();

    return { type: "CHAT_RESPONSE", ts: replyTs, message: reply };
  }
}
