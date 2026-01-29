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

    const ctx = {
      state: this.#state,
      isNight: this.#lastSensor?.isNight ?? false,
      mood: this.#mood,
      history: this.#chatHistory
    };

    // UX: show an immediate "thinking" indicator near the avatar so users get feedback
    // even if the LLM takes time. The reply bubble will replace it automatically.
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

    const reply = await this.#llm.chatReply(ctx, req.message);
    const replyTs = Date.now();

    this.#chatHistory.push({ role: "user", content: req.message });
    this.#chatHistory.push({ role: "assistant", content: reply });
    this.#chatHistory = this.#chatHistory.slice(-40);

    try {
      this.#memory.logChatMessage({ ts: replyTs, role: "assistant", content: reply });
    } catch {}

    // Chat reply is rendered as a bubble near the character (separate from the input UI).
    const bubble = truncateByCodepoints(normalizeBubbleText(reply), 180);
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

    return { type: "CHAT_RESPONSE", ts: replyTs, message: reply };
  }
}
