import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ActionCommand, ChatLogEntry, UserInteraction } from "@sama/shared";

export type MemoryServiceOpts = {
  dbPath: string;
};

type DailyStats = { date: string; proactive_count: number; ignore_count: number };
type ChatRow = { id: number; ts: number; role: "user" | "assistant"; content: string };
type MemoryNoteRow = { id: number; created_ts: number; updated_ts: number; kind: string; content: string };
type MemoryFactRow = { id: number; created_ts: number; updated_ts: number; kind: string; key: string; value: string };

const CHAT_RETENTION_LIMIT = 2000;
const NOTE_RETENTION_LIMIT = 400;
const DEFAULT_AGENT_MEMORY_CONFIG = {
  injectLimit: 12,
  autoRemember: false,
  autoMode: "rules" as const,
  // Short-term summary ("working memory") helps continuity.
  summaryEnabled: true,
  // Re-rank memory notes/facts with the LLM for better relevance (costs extra tokens/latency).
  llmRerank: true
};

const KV_CHAT_SUMMARY = "chat.summary.v1";
const KV_CHAT_SUMMARY_JSON = "chat.summary.json.v1";
const KV_CHAT_SUMMARY_LAST_ID = "chat.summary.lastId.v1";

function tokenizeForSearch(raw: string): string[] {
  const s = String(raw ?? "").toLowerCase();
  if (!s.trim()) return [];

  const out: string[] = [];

  // Latin words / ids (models, libs, filenames, etc.)
  const words = s.match(/[a-z0-9_./-]{2,}/g) ?? [];
  out.push(...words);

  // Chinese sequences
  const zh = s.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  out.push(...zh);

  // De-dupe, prefer longer tokens first (reduces noisy single-char matches).
  const uniq = Array.from(new Set(out.map((x) => x.trim()).filter(Boolean)));
  uniq.sort((a, b) => b.length - a.length);
  return uniq.slice(0, 12);
}

export class MemoryService {
  #dbPath: string;
  #enabled = false;
  #db: any | null = null;

  constructor(opts: MemoryServiceOpts) {
    this.#dbPath = opts.dbPath;
  }

  get enabled() {
    return this.#enabled;
  }

  async init() {
    try {
      mkdirSync(dirname(this.#dbPath), { recursive: true });
      const mod: any = await import("better-sqlite3");
      const Database = mod.default ?? mod;
      this.#db = new Database(this.#dbPath);
      this.#enabled = true;
      this.#migrate();
    } catch (err) {
      this.#enabled = false;
      this.#db = null;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("NODE_MODULE_VERSION") || msg.includes("compiled against a different")) {
        console.warn(
          "[memory] SQLite disabled (native module ABI mismatch). Run `pnpm --filter @sama/stage-desktop rebuild:native` then restart."
        );
      }
      console.warn("[memory] SQLite disabled (fallback to in-memory):", err);
    }
  }

  #migrate() {
    if (!this.#db) return;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS events(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS interactions(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        event TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS daily_stats(
        date TEXT PRIMARY KEY,
        proactive_count INTEGER NOT NULL,
        ignore_count INTEGER NOT NULL
      );

      -- Chat history (long-term memory foundation).
      CREATE TABLE IF NOT EXISTS chat_messages(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_messages_ts ON chat_messages(ts);

      -- Durable memory notes (user profile/preferences/long-term facts).
      CREATE TABLE IF NOT EXISTS memory_notes(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_ts INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        UNIQUE(kind, content)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_notes_updated ON memory_notes(updated_ts);

      -- Keyed durable facts (for things that should be overwritten instead of duplicated).
      CREATE TABLE IF NOT EXISTS memory_facts(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_ts INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_facts_updated ON memory_facts(updated_ts);

      -- Simple key/value settings for memory features.
      CREATE TABLE IF NOT EXISTS kv(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  #getKv(key: string): string | null {
    if (!this.#db) return null;
    try {
      const row = this.#db.prepare("SELECT value FROM kv WHERE key=?").get(String(key)) as { value?: string } | undefined;
      const v = typeof row?.value === "string" ? row.value : "";
      return v ? v : null;
    } catch {
      return null;
    }
  }

  #setKv(key: string, value: string) {
    if (!this.#db) return;
    try {
      this.#db.prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
        String(key),
        String(value ?? "")
      );
    } catch {}
  }

  getAgentMemoryConfig(): {
    injectLimit: number;
    autoRemember: boolean;
    autoMode: "rules" | "llm";
    summaryEnabled: boolean;
    llmRerank: boolean;
  } {
    if (!this.#db) return { ...DEFAULT_AGENT_MEMORY_CONFIG };

    const injectLimit = (() => {
      const raw = this.#getKv("memory.injectLimit");
      const n = Math.floor(Number(raw));
      if (!Number.isFinite(n)) return DEFAULT_AGENT_MEMORY_CONFIG.injectLimit;
      return Math.max(0, Math.min(40, n));
    })();

    const autoRemember = (() => {
      const raw = this.#getKv("memory.autoRemember");
      if (raw === null) return DEFAULT_AGENT_MEMORY_CONFIG.autoRemember;
      return raw === "1" || raw.toLowerCase() === "true";
    })();

    const autoMode = (() => {
      const raw = (this.#getKv("memory.autoMode") ?? DEFAULT_AGENT_MEMORY_CONFIG.autoMode).toLowerCase();
      return raw === "llm" ? "llm" : "rules";
    })();

    const summaryEnabled = (() => {
      const raw = this.#getKv("memory.summaryEnabled");
      if (raw === null) return DEFAULT_AGENT_MEMORY_CONFIG.summaryEnabled;
      return raw === "1" || raw.toLowerCase() === "true";
    })();

    const llmRerank = (() => {
      const raw = this.#getKv("memory.llmRerank");
      if (raw === null) return DEFAULT_AGENT_MEMORY_CONFIG.llmRerank;
      return raw === "1" || raw.toLowerCase() === "true";
    })();

    return { injectLimit, autoRemember, autoMode, summaryEnabled, llmRerank };
  }

  setAgentMemoryConfig(
    partial: any
  ): {
    ok: boolean;
    config: {
      injectLimit: number;
      autoRemember: boolean;
      autoMode: "rules" | "llm";
      summaryEnabled: boolean;
      llmRerank: boolean;
    };
  } {
    if (!this.#db) return { ok: false, config: { ...DEFAULT_AGENT_MEMORY_CONFIG } };

    const prev = this.getAgentMemoryConfig();
    const next = {
      injectLimit:
        partial && partial.injectLimit !== undefined
          ? Math.max(0, Math.min(40, Math.floor(Number(partial.injectLimit) || 0)))
          : prev.injectLimit,
      autoRemember: partial && partial.autoRemember !== undefined ? Boolean(partial.autoRemember) : prev.autoRemember,
      autoMode:
        partial && typeof partial.autoMode === "string"
          ? partial.autoMode.toLowerCase() === "llm"
            ? "llm"
            : "rules"
          : prev.autoMode,
      summaryEnabled: partial && partial.summaryEnabled !== undefined ? Boolean(partial.summaryEnabled) : prev.summaryEnabled,
      llmRerank: partial && partial.llmRerank !== undefined ? Boolean(partial.llmRerank) : prev.llmRerank
    } as const;

    try {
      this.#setKv("memory.injectLimit", String(next.injectLimit));
      this.#setKv("memory.autoRemember", next.autoRemember ? "1" : "0");
      this.#setKv("memory.autoMode", next.autoMode);
      this.#setKv("memory.summaryEnabled", next.summaryEnabled ? "1" : "0");
      this.#setKv("memory.llmRerank", next.llmRerank ? "1" : "0");
      return { ok: true, config: next };
    } catch {
      return { ok: false, config: next };
    }
  }

  logAction(cmd: ActionCommand) {
    if (!this.#db) return;
    const stmt = this.#db.prepare("INSERT INTO events(ts, kind, payload) VALUES(?,?,?)");
    stmt.run(cmd.ts, "action", JSON.stringify(cmd));
  }

  logInteraction(i: UserInteraction) {
    if (!this.#db) return;
    const stmt = this.#db.prepare("INSERT INTO interactions(ts, event, payload) VALUES(?,?,?)");
    stmt.run(i.ts, i.event, JSON.stringify(i));
  }

  logChatMessage(m: { ts: number; role: "user" | "assistant"; content: string }) {
    if (!this.#db) return;
    const ts = Number(m.ts || Date.now());
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = String(m.content ?? "").trim();
    if (!content) return;

    const stmt = this.#db.prepare("INSERT INTO chat_messages(ts, role, content) VALUES(?,?,?)");
    const info = stmt.run(ts, role, content);

    // Keep the DB bounded so it stays fast and predictable.
    const lastId = Number((info as any)?.lastInsertRowid ?? 0);
    if (Number.isFinite(lastId) && lastId > CHAT_RETENTION_LIMIT + 10) {
      const cutoff = lastId - CHAT_RETENTION_LIMIT;
      try {
        this.#db.prepare("DELETE FROM chat_messages WHERE id <= ?").run(cutoff);
      } catch {}
    }
  }

  getRecentChatHistory(limit: number): { role: "user" | "assistant"; content: string }[] {
    if (!this.#db) return [];
    const n = Math.max(0, Math.min(400, Math.floor(Number(limit) || 0)));
    if (!n) return [];
    const stmt = this.#db.prepare(
      "SELECT id, ts, role, content FROM chat_messages ORDER BY id DESC LIMIT ?"
    );
    const rows = (stmt.all(n) as ChatRow[]) ?? [];
    rows.reverse(); // oldest -> newest
    return rows.map((r) => ({
      role: r.role === "assistant" ? "assistant" : "user",
      content: String(r.content ?? "")
    }));
  }

  getRecentChatMessagesWithIds(limit: number): { id: number; role: "user" | "assistant"; content: string }[] {
    if (!this.#db) return [];
    const n = Math.max(0, Math.min(400, Math.floor(Number(limit) || 0)));
    if (!n) return [];
    const stmt = this.#db.prepare("SELECT id, role, content FROM chat_messages ORDER BY id DESC LIMIT ?");
    const rows = (stmt.all(n) as Pick<ChatRow, "id" | "role" | "content">[]) ?? [];
    rows.reverse(); // oldest -> newest
    return rows.map((r) => ({
      id: Number((r as any).id ?? 0) || 0,
      role: (r as any).role === "assistant" ? "assistant" : "user",
      content: String((r as any).content ?? "")
    }));
  }

  getRecentChatLogEntries(limit: number): ChatLogEntry[] {
    if (!this.#db) return [];
    const n = Math.max(0, Math.min(400, Math.floor(Number(limit) || 0)));
    if (!n) return [];
    const stmt = this.#db.prepare(
      "SELECT id, ts, role, content FROM chat_messages ORDER BY id DESC LIMIT ?"
    );
    const rows = (stmt.all(n) as ChatRow[]) ?? [];
    rows.reverse(); // oldest -> newest

    return rows.map((r) => ({
      id: `${r.role === "assistant" ? "a" : "u"}_${r.id}`,
      ts: Number(r.ts || 0),
      role: r.role === "assistant" ? "assistant" : "user",
      content: String(r.content ?? "")
    }));
  }

  upsertMemoryNote(note: { kind: string; content: string; ts?: number }) {
    if (!this.#db) return false;
    const kind = String(note.kind ?? "").trim() || "note";
    const content = String(note.content ?? "").trim();
    if (!content) return false;

    const now = Math.max(1, Math.floor(Number(note.ts ?? Date.now())));
    try {
      // If exists, only bump updated_ts.
      const exists = this.#db
        .prepare("SELECT id FROM memory_notes WHERE kind=? AND content=?")
        .get(kind, content) as { id: number } | undefined;

      if (exists?.id) {
        this.#db.prepare("UPDATE memory_notes SET updated_ts=? WHERE id=?").run(now, exists.id);
      } else {
        this.#db
          .prepare("INSERT INTO memory_notes(created_ts, updated_ts, kind, content) VALUES(?,?,?,?)")
          .run(now, now, kind, content);
      }

      // Bound table size.
      const last = this.#db.prepare("SELECT MAX(id) AS id FROM memory_notes").get() as { id?: number } | undefined;
      const lastId = Number(last?.id ?? 0);
      if (Number.isFinite(lastId) && lastId > NOTE_RETENTION_LIMIT + 10) {
        const cutoff = lastId - NOTE_RETENTION_LIMIT;
        try {
          this.#db.prepare("DELETE FROM memory_notes WHERE id <= ?").run(cutoff);
        } catch {}
      }
      return true;
    } catch {
      return false;
    }
  }

  listMemoryNotes(limit: number): { id: number; kind: string; content: string; updatedTs: number }[] {
    if (!this.#db) return [];
    const n = Math.max(0, Math.min(400, Math.floor(Number(limit) || 0)));
    if (!n) return [];
    const stmt = this.#db.prepare(
      "SELECT id, created_ts, updated_ts, kind, content FROM memory_notes ORDER BY updated_ts DESC, id DESC LIMIT ?"
    );
    const rows = (stmt.all(n) as MemoryNoteRow[]) ?? [];
    return rows.map((r) => ({
      id: Number(r.id ?? 0) || 0,
      kind: String(r.kind ?? "note"),
      content: String(r.content ?? ""),
      updatedTs: Number(r.updated_ts ?? 0)
    }));
  }

  upsertMemoryFact(fact: { key: string; kind: string; value: string; ts?: number }) {
    if (!this.#db) return false;
    const key = String(fact.key ?? "").trim();
    if (!key) return false;
    const kind = String(fact.kind ?? "").trim() || "fact";
    const value = String(fact.value ?? "").trim();
    if (!value) return false;

    const now = Math.max(1, Math.floor(Number(fact.ts ?? Date.now())));
    try {
      const exists = this.#db
        .prepare("SELECT id FROM memory_facts WHERE key=?")
        .get(key) as { id: number } | undefined;

      if (exists?.id) {
        this.#db.prepare("UPDATE memory_facts SET kind=?, value=?, updated_ts=? WHERE id=?").run(kind, value, now, exists.id);
      } else {
        this.#db
          .prepare("INSERT INTO memory_facts(created_ts, updated_ts, kind, key, value) VALUES(?,?,?,?,?)")
          .run(now, now, kind, key, value);
      }
      return true;
    } catch {
      return false;
    }
  }

  listMemoryFacts(limit: number): { id: number; kind: string; key: string; value: string; updatedTs: number }[] {
    if (!this.#db) return [];
    const n = Math.max(0, Math.min(200, Math.floor(Number(limit) || 0)));
    if (!n) return [];
    const stmt = this.#db.prepare(
      "SELECT id, created_ts, updated_ts, kind, key, value FROM memory_facts ORDER BY updated_ts DESC, id DESC LIMIT ?"
    );
    const rows = (stmt.all(n) as MemoryFactRow[]) ?? [];
    return rows.map((r) => ({
      id: Number(r.id ?? 0) || 0,
      kind: String(r.kind ?? "fact"),
      key: String(r.key ?? ""),
      value: String(r.value ?? ""),
      updatedTs: Number(r.updated_ts ?? 0)
    }));
  }

  deleteMemoryFactById(id: number) {
    if (!this.#db) return false;
    const n = Math.floor(Number(id) || 0);
    if (!Number.isFinite(n) || n <= 0) return false;
    try {
      const info = this.#db.prepare("DELETE FROM memory_facts WHERE id=?").run(n);
      return Number((info as any)?.changes ?? 0) > 0;
    } catch {
      return false;
    }
  }

  updateMemoryFactById(id: number, value: string, ts?: number) {
    if (!this.#db) return false;
    const n = Math.floor(Number(id) || 0);
    const next = String(value ?? "").trim();
    if (!Number.isFinite(n) || n <= 0) return false;
    if (!next) return false;

    const now = Math.max(1, Math.floor(Number(ts ?? Date.now())));
    try {
      const info = this.#db.prepare("UPDATE memory_facts SET value=?, updated_ts=? WHERE id=?").run(next, now, n);
      return Number((info as any)?.changes ?? 0) > 0;
    } catch {
      return false;
    }
  }

  getMemoryPrompt(limit: number): string {
    const notes = this.listMemoryNotes(limit);
    if (!notes.length) return "";
    return this.formatMemoryPrompt({ facts: [], notes });
  }

  formatMemoryPrompt(opts: {
    facts: { id: number; kind: string; key: string; value: string; updatedTs: number }[];
    notes: { id: number; kind: string; content: string; updatedTs: number }[];
  }): string {
    const facts = Array.isArray(opts?.facts) ? opts.facts : [];
    const notes = Array.isArray(opts?.notes) ? opts.notes : [];

    const sections: string[] = [];
    if (facts.length) {
      const lines: string[] = [];
      for (const f of facts) {
        const kind = f.kind && f.kind !== "fact" ? `(${f.kind}) ` : "";
        lines.push(`- ${kind}${f.key}: ${f.value}`);
      }
      sections.push(`【长期记忆·事实】\n${lines.join("\n")}`);
    }
    if (notes.length) {
      const lines: string[] = [];
      for (const n of notes) {
        const kind = n.kind && n.kind !== "note" ? `(${n.kind}) ` : "";
        lines.push(`- ${kind}${n.content}`);
      }
      sections.push(`【长期记忆·笔记】\n${lines.join("\n")}`);
    }
    return sections.join("\n\n");
  }

  getRelevantMemoryNotes(query: string, limit: number): { id: number; kind: string; content: string; updatedTs: number }[] {
    const n = Math.max(0, Math.min(60, Math.floor(Number(limit) || 0)));
    if (!n) return [];

    // Fast path: when query is empty, behave like the old implementation (most recent notes).
    const tokens = tokenizeForSearch(query);
    if (!tokens.length) return this.listMemoryNotes(n);

    // Notes are capped at ~400 rows; in-memory scoring is fast and keeps SQL simple.
    const notes = this.listMemoryNotes(400);
    const scored: { note: { id: number; kind: string; content: string; updatedTs: number }; score: number }[] = [];

    const now = Date.now();
    for (const note of notes) {
      const content = String(note.content ?? "");
      const hay = content.toLowerCase();

      let score = 0;
      for (const t of tokens) {
        if (!t) continue;
        if (hay.includes(t)) score += Math.min(8, Math.max(1, t.length));
      }

      // Small bias towards certain kinds (profile/preference/project are more valuable).
      const kind = String(note.kind ?? "note").toLowerCase();
      if (kind === "profile") score += 2.2;
      else if (kind === "preference" || kind === "project") score += 1.2;

      // Very small recency boost so ties are stable.
      const ageDays = Math.max(0, (now - Number(note.updatedTs || 0)) / 86_400_000);
      score += Math.max(0, 1.4 - ageDays * 0.08);

      if (score > 0.5) scored.push({ note, score });
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.note.updatedTs || 0) - (a.note.updatedTs || 0);
    });

    const picked = scored.slice(0, n).map((x) => x.note);
    return picked.length ? picked : this.listMemoryNotes(n);
  }

  getRelevantMemoryFacts(
    query: string,
    limit: number
  ): { id: number; kind: string; key: string; value: string; updatedTs: number }[] {
    const n = Math.max(0, Math.min(60, Math.floor(Number(limit) || 0)));
    if (!n) return [];

    const tokens = tokenizeForSearch(query);
    const facts = this.listMemoryFacts(200);

    if (!tokens.length) return facts.slice(0, n);

    const scored: { fact: { id: number; kind: string; key: string; value: string; updatedTs: number }; score: number }[] = [];
    const now = Date.now();
    for (const fact of facts) {
      const hay = `${fact.key}\n${fact.value}`.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (!t) continue;
        if (hay.includes(t)) score += Math.min(9, Math.max(1, t.length));
      }
      const kind = String(fact.kind ?? "fact").toLowerCase();
      if (kind === "profile") score += 2.2;
      else if (kind === "preference" || kind === "project") score += 1.2;

      const ageDays = Math.max(0, (now - Number(fact.updatedTs || 0)) / 86_400_000);
      score += Math.max(0, 1.4 - ageDays * 0.08);

      if (score > 0.5) scored.push({ fact, score });
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.fact.updatedTs || 0) - (a.fact.updatedTs || 0);
    });

    const picked = scored.slice(0, n).map((x) => x.fact);
    return picked.length ? picked : facts.slice(0, n);
  }

  getMemoryPromptForQuery(query: string, limit: number): string {
    const n = Math.max(0, Math.min(40, Math.floor(Number(limit) || 0)));
    if (!n) return "";

    // Heuristic split: reserve some space for keyed facts, but don't starve notes.
    const factBudget = Math.min(10, Math.max(2, Math.round(n * 0.35)));
    const noteBudget = Math.max(0, n - factBudget);

    const facts = this.getRelevantMemoryFacts(query, factBudget);
    const notes = this.getRelevantMemoryNotes(query, noteBudget);
    return this.formatMemoryPrompt({ facts, notes });
  }

  getConversationSummary(): { summary: string; summaryJson: any | null; lastId: number } {
    const summary = this.#getKv(KV_CHAT_SUMMARY) ?? "";
    const jsonRaw = this.#getKv(KV_CHAT_SUMMARY_JSON);
    const summaryJson = (() => {
      if (!jsonRaw) return null;
      try {
        return JSON.parse(jsonRaw);
      } catch {
        return null;
      }
    })();
    const lastIdRaw = this.#getKv(KV_CHAT_SUMMARY_LAST_ID);
    const lastId = Math.max(0, Math.floor(Number(lastIdRaw ?? 0) || 0));
    return { summary, summaryJson, lastId };
  }

  setConversationSummary(summary: string, summaryJson: any | null, lastId: number) {
    if (!this.#db) return;
    const s = String(summary ?? "").trim();
    const id = Math.max(0, Math.floor(Number(lastId) || 0));
    try {
      this.#setKv(KV_CHAT_SUMMARY, s);
      this.#setKv(KV_CHAT_SUMMARY_JSON, summaryJson ? JSON.stringify(summaryJson) : "");
      this.#setKv(KV_CHAT_SUMMARY_LAST_ID, String(id));
    } catch {}
  }

  clearConversationSummary() {
    if (!this.#db) return;
    try {
      this.#setKv(KV_CHAT_SUMMARY, "");
      this.#setKv(KV_CHAT_SUMMARY_JSON, "");
      this.#setKv(KV_CHAT_SUMMARY_LAST_ID, "0");
    } catch {}
  }

  getChatMessagesSinceId(sinceId: number, limit: number): { id: number; role: "user" | "assistant"; content: string }[] {
    if (!this.#db) return [];
    const since = Math.max(0, Math.floor(Number(sinceId) || 0));
    const n = Math.max(0, Math.min(120, Math.floor(Number(limit) || 0)));
    if (!n) return [];
    try {
      const stmt = this.#db.prepare(
        "SELECT id, role, content FROM chat_messages WHERE id > ? ORDER BY id ASC LIMIT ?"
      );
      const rows = (stmt.all(since, n) as Pick<ChatRow, "id" | "role" | "content">[]) ?? [];
      return rows.map((r) => ({
        id: Number((r as any).id ?? 0) || 0,
        role: (r as any).role === "assistant" ? "assistant" : "user",
        content: String((r as any).content ?? "")
      }));
    } catch {
      return [];
    }
  }

  getMemoryStats(): { enabled: boolean; chatCount: number; noteCount: number; factCount: number } {
    if (!this.#db) return { enabled: false, chatCount: 0, noteCount: 0, factCount: 0 };
    try {
      const chat = this.#db.prepare("SELECT COUNT(1) AS n FROM chat_messages").get() as { n?: number } | undefined;
      const notes = this.#db.prepare("SELECT COUNT(1) AS n FROM memory_notes").get() as { n?: number } | undefined;
      const facts = this.#db.prepare("SELECT COUNT(1) AS n FROM memory_facts").get() as { n?: number } | undefined;
      return {
        enabled: true,
        chatCount: Number(chat?.n ?? 0) || 0,
        noteCount: Number(notes?.n ?? 0) || 0,
        factCount: Number(facts?.n ?? 0) || 0
      };
    } catch {
      return { enabled: true, chatCount: 0, noteCount: 0, factCount: 0 };
    }
  }

  clearChatHistory() {
    if (!this.#db) return;
    try {
      this.#db.prepare("DELETE FROM chat_messages").run();
      // Reset summary too, since it's derived from chat history.
      this.clearConversationSummary();
    } catch {}
  }

  clearMemoryNotes() {
    if (!this.#db) return;
    try {
      this.#db.prepare("DELETE FROM memory_notes").run();
    } catch {}
  }

  clearMemoryFacts() {
    if (!this.#db) return;
    try {
      this.#db.prepare("DELETE FROM memory_facts").run();
    } catch {}
  }

  deleteMemoryNoteById(id: number) {
    if (!this.#db) return false;
    const n = Math.floor(Number(id) || 0);
    if (!Number.isFinite(n) || n <= 0) return false;
    try {
      const info = this.#db.prepare("DELETE FROM memory_notes WHERE id=?").run(n);
      return Number((info as any)?.changes ?? 0) > 0;
    } catch {
      return false;
    }
  }

  deleteMemoryNoteByKindAndContent(kind: string, content: string) {
    if (!this.#db) return false;
    const k = String(kind ?? "").trim() || "note";
    const c = String(content ?? "").trim();
    if (!c) return false;
    try {
      const info = this.#db.prepare("DELETE FROM memory_notes WHERE kind=? AND content=?").run(k, c);
      return Number((info as any)?.changes ?? 0) > 0;
    } catch {
      return false;
    }
  }

  updateMemoryNoteById(id: number, content: string, ts?: number) {
    if (!this.#db) return false;
    const n = Math.floor(Number(id) || 0);
    const next = String(content ?? "").trim();
    if (!Number.isFinite(n) || n <= 0) return false;
    if (!next) return false;

    const now = Math.max(1, Math.floor(Number(ts ?? Date.now())));
    try {
      const row = this.#db
        .prepare("SELECT id, kind, content FROM memory_notes WHERE id=?")
        .get(n) as { id: number; kind: string; content: string } | undefined;
      if (!row?.id) return false;

      const kind = String(row.kind ?? "note").trim() || "note";

      if (String(row.content ?? "").trim() === next) {
        this.#db.prepare("UPDATE memory_notes SET updated_ts=? WHERE id=?").run(now, n);
        return true;
      }

      try {
        this.#db.prepare("UPDATE memory_notes SET content=?, updated_ts=? WHERE id=?").run(next, now, n);
        return true;
      } catch (err) {
        // UNIQUE(kind, content) conflict: merge into existing and delete this row.
        try {
          const existing = this.#db
            .prepare("SELECT id FROM memory_notes WHERE kind=? AND content=?")
            .get(kind, next) as { id: number } | undefined;
          if (existing?.id) {
            this.#db.prepare("UPDATE memory_notes SET updated_ts=? WHERE id=?").run(now, existing.id);
            this.#db.prepare("DELETE FROM memory_notes WHERE id=?").run(n);
            return true;
          }
        } catch {}
        throw err;
      }
    } catch {
      return false;
    }
  }

  getOrInitDaily(date: string): DailyStats {
    if (!this.#db) return { date, proactive_count: 0, ignore_count: 0 };

    const sel = this.#db.prepare("SELECT date, proactive_count, ignore_count FROM daily_stats WHERE date=?");
    const row = sel.get(date) as DailyStats | undefined;
    if (row) return row;

    const ins = this.#db.prepare("INSERT INTO daily_stats(date, proactive_count, ignore_count) VALUES(?,?,?)");
    ins.run(date, 0, 0);
    return { date, proactive_count: 0, ignore_count: 0 };
  }

  incrementProactive(date: string) {
    if (!this.#db) return;
    this.getOrInitDaily(date);
    const stmt = this.#db.prepare(
      "UPDATE daily_stats SET proactive_count = proactive_count + 1 WHERE date=?"
    );
    stmt.run(date);
  }

  incrementIgnore(date: string) {
    if (!this.#db) return;
    this.getOrInitDaily(date);
    const stmt = this.#db.prepare("UPDATE daily_stats SET ignore_count = ignore_count + 1 WHERE date=?");
    stmt.run(date);
  }

  getDaily(date: string): DailyStats {
    if (!this.#db) return { date, proactive_count: 0, ignore_count: 0 };
    return this.getOrInitDaily(date);
  }
}
