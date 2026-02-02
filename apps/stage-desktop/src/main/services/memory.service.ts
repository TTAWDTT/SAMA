import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
const FACT_RETENTION_LIMIT = 400;
const DEFAULT_AGENT_MEMORY_CONFIG = {
  injectLimit: 12,
  autoRemember: true,
  autoMode: "llm" as const,
  // Short-term summary ("working memory") helps continuity.
  summaryEnabled: true,
  // Re-rank memory notes/facts with the LLM for better relevance (costs extra tokens/latency).
  llmRerank: true
};

const KV_CHAT_SUMMARY = "chat.summary.v1";
const KV_CHAT_SUMMARY_JSON = "chat.summary.json.v1";
const KV_CHAT_SUMMARY_LAST_ID = "chat.summary.lastId.v1";

const FALLBACK_STATE_VERSION = 1 as const;
const FALLBACK_FILE_NAME = "memory.fallback.v1.json";
const FALLBACK_FLUSH_DEBOUNCE_MS = 400;

type FallbackState = {
  version: typeof FALLBACK_STATE_VERSION;
  next: { chatId: number; noteId: number; factId: number };
  kv: Record<string, string>;
  chat: ChatRow[];
  notes: MemoryNoteRow[];
  facts: MemoryFactRow[];
  daily: Record<string, DailyStats>;
};

function defaultFallbackState(): FallbackState {
  return {
    version: FALLBACK_STATE_VERSION,
    next: { chatId: 1, noteId: 1, factId: 1 },
    kv: {},
    chat: [],
    notes: [],
    facts: [],
    daily: {}
  };
}

function safeInt(v: unknown, fallback: number) {
  const n = Math.floor(Number(v) || 0);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function loadFallbackState(p: string): FallbackState {
  try {
    if (!existsSync(p)) return defaultFallbackState();
    const raw = readFileSync(p, "utf-8");
    const parsed: any = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return defaultFallbackState();
    if (Number(parsed.version) !== FALLBACK_STATE_VERSION) return defaultFallbackState();

    const st: FallbackState = defaultFallbackState();
    st.next.chatId = Math.max(1, safeInt(parsed?.next?.chatId, st.next.chatId));
    st.next.noteId = Math.max(1, safeInt(parsed?.next?.noteId, st.next.noteId));
    st.next.factId = Math.max(1, safeInt(parsed?.next?.factId, st.next.factId));

    if (parsed.kv && typeof parsed.kv === "object" && !Array.isArray(parsed.kv)) {
      for (const [k, v] of Object.entries(parsed.kv as any)) {
        if (!k) continue;
        st.kv[String(k)] = String(v ?? "");
      }
    }

    st.chat = Array.isArray(parsed.chat) ? (parsed.chat as any[]).slice(-CHAT_RETENTION_LIMIT) as any : [];
    st.notes = Array.isArray(parsed.notes) ? (parsed.notes as any[]).slice(-NOTE_RETENTION_LIMIT) as any : [];
    st.facts = Array.isArray(parsed.facts) ? (parsed.facts as any[]).slice(-FACT_RETENTION_LIMIT) as any : [];

    if (parsed.daily && typeof parsed.daily === "object" && !Array.isArray(parsed.daily)) {
      for (const [k, v] of Object.entries(parsed.daily as any)) {
        const date = String(k ?? "").trim();
        if (!date) continue;
        const row: any = v ?? {};
        st.daily[date] = {
          date,
          proactive_count: Math.max(0, safeInt(row.proactive_count, 0)),
          ignore_count: Math.max(0, safeInt(row.ignore_count, 0))
        };
      }
    }

    // Recompute next ids so they remain monotonic even if the file was edited.
    const maxChatId = st.chat.reduce((m, r) => Math.max(m, safeInt((r as any)?.id, 0)), 0);
    const maxNoteId = st.notes.reduce((m, r) => Math.max(m, safeInt((r as any)?.id, 0)), 0);
    const maxFactId = st.facts.reduce((m, r) => Math.max(m, safeInt((r as any)?.id, 0)), 0);
    st.next.chatId = Math.max(st.next.chatId, maxChatId + 1);
    st.next.noteId = Math.max(st.next.noteId, maxNoteId + 1);
    st.next.factId = Math.max(st.next.factId, maxFactId + 1);

    return st;
  } catch {
    return defaultFallbackState();
  }
}

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
  #fallbackPath: string | null = null;
  #fallback: FallbackState | null = null;
  #fallbackDirty = false;
  #fallbackFlushTimer: NodeJS.Timeout | null = null;

  constructor(opts: MemoryServiceOpts) {
    this.#dbPath = opts.dbPath;
  }

  get enabled() {
    return this.#enabled;
  }

  #touchFallback() {
    if (!this.#fallbackPath || !this.#fallback) return;
    this.#fallbackDirty = true;
    if (this.#fallbackFlushTimer) return;
    this.#fallbackFlushTimer = setTimeout(() => {
      this.#fallbackFlushTimer = null;
      if (!this.#fallbackDirty) return;
      try {
        writeFileSync(this.#fallbackPath!, JSON.stringify(this.#fallback, null, 2), "utf-8");
        this.#fallbackDirty = false;
      } catch (err) {
        console.warn("[memory] failed to persist fallback store:", err);
      }
    }, FALLBACK_FLUSH_DEBOUNCE_MS);
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
      this.#db = null;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("NODE_MODULE_VERSION") || msg.includes("compiled against a different")) {
        console.warn(
          "[memory] SQLite disabled (native module ABI mismatch). Run `pnpm --filter @sama/stage-desktop rebuild:native` then restart."
        );
      }

      // Elegant fallback: keep memory working even when native SQLite is unavailable.
      // This avoids the "long-term memory never writes" failure mode on ABI mismatch.
      try {
        const dir = dirname(this.#dbPath);
        mkdirSync(dir, { recursive: true });
        const p = join(dir, FALLBACK_FILE_NAME);
        this.#fallbackPath = p;
        this.#fallback = loadFallbackState(p);
        this.#enabled = true;
        console.warn("[memory] SQLite disabled, using JSON fallback store:", p);
        this.#touchFallback();
      } catch (fallbackErr) {
        this.#enabled = false;
        this.#fallbackPath = null;
        this.#fallback = null;
        console.warn("[memory] SQLite disabled (fallback store init failed):", fallbackErr);
      }
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
    if (this.#db) {
      try {
        const row = this.#db
          .prepare("SELECT value FROM kv WHERE key=?")
          .get(String(key)) as { value?: string } | undefined;
        const v = typeof row?.value === "string" ? row.value : "";
        return v ? v : null;
      } catch {
        return null;
      }
    }

    if (this.#fallback) {
      const v = String(this.#fallback.kv[String(key)] ?? "").trim();
      return v ? v : null;
    }

    return null;
  }

  #setKv(key: string, value: string) {
    if (this.#db) {
      try {
        this.#db
          .prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run(String(key), String(value ?? ""));
      } catch {}
      return;
    }

    if (this.#fallback) {
      this.#fallback.kv[String(key)] = String(value ?? "");
      this.#touchFallback();
    }
  }

  getAgentMemoryConfig(): {
    injectLimit: number;
    autoRemember: boolean;
    autoMode: "rules" | "llm";
    summaryEnabled: boolean;
    llmRerank: boolean;
  } {
    if (!this.#db && !this.#fallback) return { ...DEFAULT_AGENT_MEMORY_CONFIG };

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
    if (!this.#db && !this.#fallback) return { ok: false, config: { ...DEFAULT_AGENT_MEMORY_CONFIG } };

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
    const ts = Number(m.ts || Date.now());
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = String(m.content ?? "").trim();
    if (!content) return;

    if (this.#db) {
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
      return;
    }

    if (!this.#fallback) return;
    const id = this.#fallback.next.chatId++;
    this.#fallback.chat.push({ id, ts, role, content });
    if (this.#fallback.chat.length > CHAT_RETENTION_LIMIT + 10) {
      this.#fallback.chat = this.#fallback.chat.slice(-CHAT_RETENTION_LIMIT);
    }
    this.#touchFallback();
  }

  getRecentChatHistory(limit: number): { role: "user" | "assistant"; content: string }[] {
    const n = Math.max(0, Math.min(400, Math.floor(Number(limit) || 0)));
    if (!n) return [];

    if (this.#db) {
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

    if (!this.#fallback) return [];
    const rows = this.#fallback.chat.slice(-n);
    return rows.map((r) => ({
      role: r.role === "assistant" ? "assistant" : "user",
      content: String(r.content ?? "")
    }));
  }

  getRecentChatMessagesWithIds(limit: number): { id: number; role: "user" | "assistant"; content: string }[] {
    const n = Math.max(0, Math.min(400, Math.floor(Number(limit) || 0)));
    if (!n) return [];

    if (this.#db) {
      const stmt = this.#db.prepare("SELECT id, role, content FROM chat_messages ORDER BY id DESC LIMIT ?");
      const rows = (stmt.all(n) as Pick<ChatRow, "id" | "role" | "content">[]) ?? [];
      rows.reverse(); // oldest -> newest
      return rows.map((r) => ({
        id: Number((r as any).id ?? 0) || 0,
        role: (r as any).role === "assistant" ? "assistant" : "user",
        content: String((r as any).content ?? "")
      }));
    }

    if (!this.#fallback) return [];
    const rows = this.#fallback.chat.slice(-n);
    return rows.map((r) => ({
      id: Number((r as any).id ?? 0) || 0,
      role: r.role === "assistant" ? "assistant" : "user",
      content: String(r.content ?? "")
    }));
  }

  getRecentChatLogEntries(limit: number): ChatLogEntry[] {
    const n = Math.max(0, Math.min(400, Math.floor(Number(limit) || 0)));
    if (!n) return [];

    if (this.#db) {
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

    if (!this.#fallback) return [];
    const rows = this.#fallback.chat.slice(-n);
    return rows.map((r) => ({
      id: `${r.role === "assistant" ? "a" : "u"}_${r.id}`,
      ts: Number(r.ts || 0),
      role: r.role === "assistant" ? "assistant" : "user",
      content: String(r.content ?? "")
    }));
  }

  upsertMemoryNote(note: { kind: string; content: string; ts?: number }) {
    const kind = String(note.kind ?? "").trim() || "note";
    const content = String(note.content ?? "").trim();
    if (!content) return false;

    const now = Math.max(1, Math.floor(Number(note.ts ?? Date.now())));

    if (this.#db) {
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

    if (!this.#fallback) return false;
    try {
      const exists = this.#fallback.notes.find((n) => String(n.kind ?? "note") === kind && String(n.content ?? "") === content);
      if (exists?.id) {
        exists.updated_ts = now;
      } else {
        const id = this.#fallback.next.noteId++;
        this.#fallback.notes.push({ id, created_ts: now, updated_ts: now, kind, content });
      }

      const maxId = this.#fallback.notes.reduce((m, r) => Math.max(m, safeInt((r as any)?.id, 0)), 0);
      if (Number.isFinite(maxId) && maxId > NOTE_RETENTION_LIMIT + 10) {
        const cutoff = maxId - NOTE_RETENTION_LIMIT;
        this.#fallback.notes = this.#fallback.notes.filter((r) => safeInt((r as any)?.id, 0) > cutoff);
      }

      this.#touchFallback();
      return true;
    } catch {
      return false;
    }
  }

  listMemoryNotes(limit: number): { id: number; kind: string; content: string; updatedTs: number }[] {
    const n = Math.max(0, Math.min(400, Math.floor(Number(limit) || 0)));
    if (!n) return [];

    if (this.#db) {
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

    if (!this.#fallback) return [];
    const rows = this.#fallback.notes
      .slice()
      .sort((a, b) => {
        const au = safeInt((a as any)?.updated_ts, 0);
        const bu = safeInt((b as any)?.updated_ts, 0);
        if (bu !== au) return bu - au;
        return safeInt((b as any)?.id, 0) - safeInt((a as any)?.id, 0);
      })
      .slice(0, n);
    return rows.map((r) => ({
      id: safeInt((r as any)?.id, 0),
      kind: String((r as any)?.kind ?? "note"),
      content: String((r as any)?.content ?? ""),
      updatedTs: safeInt((r as any)?.updated_ts, 0)
    }));
  }

  upsertMemoryFact(fact: { key: string; kind: string; value: string; ts?: number }) {
    const key = String(fact.key ?? "").trim();
    if (!key) return false;
    const kind = String(fact.kind ?? "").trim() || "fact";
    const value = String(fact.value ?? "").trim();
    if (!value) return false;

    const now = Math.max(1, Math.floor(Number(fact.ts ?? Date.now())));

    if (this.#db) {
      try {
        const exists = this.#db
          .prepare("SELECT id FROM memory_facts WHERE key=?")
          .get(key) as { id: number } | undefined;

        if (exists?.id) {
          this.#db
            .prepare("UPDATE memory_facts SET kind=?, value=?, updated_ts=? WHERE id=?")
            .run(kind, value, now, exists.id);
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

    if (!this.#fallback) return false;
    try {
      const existing = this.#fallback.facts.find((f) => String((f as any)?.key ?? "") === key);
      if (existing?.id) {
        existing.kind = kind;
        existing.value = value;
        existing.updated_ts = now;
      } else {
        const id = this.#fallback.next.factId++;
        this.#fallback.facts.push({ id, created_ts: now, updated_ts: now, kind, key, value });
      }

      const maxId = this.#fallback.facts.reduce((m, r) => Math.max(m, safeInt((r as any)?.id, 0)), 0);
      if (Number.isFinite(maxId) && maxId > FACT_RETENTION_LIMIT + 10) {
        const cutoff = maxId - FACT_RETENTION_LIMIT;
        this.#fallback.facts = this.#fallback.facts.filter((r) => safeInt((r as any)?.id, 0) > cutoff);
      }

      this.#touchFallback();
      return true;
    } catch {
      return false;
    }
  }

  listMemoryFacts(limit: number): { id: number; kind: string; key: string; value: string; updatedTs: number }[] {
    const n = Math.max(0, Math.min(200, Math.floor(Number(limit) || 0)));
    if (!n) return [];

    if (this.#db) {
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

    if (!this.#fallback) return [];
    const rows = this.#fallback.facts
      .slice()
      .sort((a, b) => {
        const au = safeInt((a as any)?.updated_ts, 0);
        const bu = safeInt((b as any)?.updated_ts, 0);
        if (bu !== au) return bu - au;
        return safeInt((b as any)?.id, 0) - safeInt((a as any)?.id, 0);
      })
      .slice(0, n);
    return rows.map((r) => ({
      id: safeInt((r as any)?.id, 0),
      kind: String((r as any)?.kind ?? "fact"),
      key: String((r as any)?.key ?? ""),
      value: String((r as any)?.value ?? ""),
      updatedTs: safeInt((r as any)?.updated_ts, 0)
    }));
  }

  deleteMemoryFactById(id: number) {
    const n = Math.floor(Number(id) || 0);
    if (!Number.isFinite(n) || n <= 0) return false;

    if (this.#db) {
      try {
        const info = this.#db.prepare("DELETE FROM memory_facts WHERE id=?").run(n);
        return Number((info as any)?.changes ?? 0) > 0;
      } catch {
        return false;
      }
    }

    if (!this.#fallback) return false;
    const before = this.#fallback.facts.length;
    this.#fallback.facts = this.#fallback.facts.filter((f) => safeInt((f as any)?.id, 0) !== n);
    const changed = this.#fallback.facts.length !== before;
    if (changed) this.#touchFallback();
    return changed;
  }

  updateMemoryFactById(id: number, value: string, ts?: number) {
    const n = Math.floor(Number(id) || 0);
    const next = String(value ?? "").trim();
    if (!Number.isFinite(n) || n <= 0) return false;
    if (!next) return false;

    const now = Math.max(1, Math.floor(Number(ts ?? Date.now())));

    if (this.#db) {
      try {
        const info = this.#db.prepare("UPDATE memory_facts SET value=?, updated_ts=? WHERE id=?").run(next, now, n);
        return Number((info as any)?.changes ?? 0) > 0;
      } catch {
        return false;
      }
    }

    if (!this.#fallback) return false;
    const row = this.#fallback.facts.find((f) => safeInt((f as any)?.id, 0) === n);
    if (!row) return false;
    row.value = next;
    row.updated_ts = now;
    this.#touchFallback();
    return true;
  }

  getMemoryPrompt(limit: number): string {
    const notes = this.listMemoryNotes(limit);
    if (!notes.length) return "";
    return this.formatMemoryPrompt({ facts: [], notes });
  }

  formatMemoryPrompt(opts: {
    facts: { id: number; kind: string; key: string; value: string; updatedTs: number }[];
    notes: { id: number; kind: string; content: string; updatedTs: number }[];
    mode?: "ui" | "model";
  }): string {
    const facts = Array.isArray(opts?.facts) ? opts.facts : [];
    const notes = Array.isArray(opts?.notes) ? opts.notes : [];
    const mode: "ui" | "model" = opts?.mode === "model" ? "model" : "ui";

    if (mode === "model") {
      const clip = (raw: unknown, max: number) => {
        const s = String(raw ?? "").replace(/\s+/g, " ").trim();
        if (!s) return "";
        const arr = Array.from(s);
        if (arr.length <= max) return s;
        const boundary = new Set(["。", "！", "？", ".", "!", "?", "；", ";", "，", ","]);
        const lookback = Math.min(36, Math.max(10, Math.floor(max * 0.25)));
        const start = Math.max(0, max - lookback);
        let cutAt = -1;
        for (let i = max - 1; i >= start; i--) {
          const ch = arr[i] ?? "";
          if (boundary.has(ch)) {
            cutAt = i + 1;
            break;
          }
        }
        return (cutAt > 0 ? arr.slice(0, cutAt) : arr.slice(0, max)).join("").trim();
      };

      const lines: string[] = [];
      for (const f of facts) {
        const kind = f.kind && f.kind !== "fact" ? `(${f.kind}) ` : "";
        const key = clip(f.key, 80);
        const value = clip(f.value, 200);
        if (!key || !value) continue;
        lines.push(`- ${kind}${key}: ${value}`);
      }
      for (const n of notes) {
        const kind = n.kind && n.kind !== "note" ? `(${n.kind}) ` : "";
        const content = clip(n.content, 240);
        if (!content) continue;
        lines.push(`- ${kind}${content}`);
      }
      return lines.join("\n").trim();
    }

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
    if (!this.#db && !this.#fallback) return;
    const s = String(summary ?? "").trim();
    const id = Math.max(0, Math.floor(Number(lastId) || 0));
    try {
      this.#setKv(KV_CHAT_SUMMARY, s);
      this.#setKv(KV_CHAT_SUMMARY_JSON, summaryJson ? JSON.stringify(summaryJson) : "");
      this.#setKv(KV_CHAT_SUMMARY_LAST_ID, String(id));
    } catch {}
  }

  clearConversationSummary() {
    if (!this.#db && !this.#fallback) return;
    try {
      this.#setKv(KV_CHAT_SUMMARY, "");
      this.#setKv(KV_CHAT_SUMMARY_JSON, "");
      this.#setKv(KV_CHAT_SUMMARY_LAST_ID, "0");
    } catch {}
  }

  getChatMessagesSinceId(sinceId: number, limit: number): { id: number; role: "user" | "assistant"; content: string }[] {
    const since = Math.max(0, Math.floor(Number(sinceId) || 0));
    const n = Math.max(0, Math.min(120, Math.floor(Number(limit) || 0)));
    if (!n) return [];

    if (this.#db) {
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

    if (!this.#fallback) return [];
    return this.#fallback.chat
      .filter((r) => safeInt((r as any)?.id, 0) > since)
      .slice(0, n)
      .map((r) => ({
        id: safeInt((r as any)?.id, 0),
        role: (r as any)?.role === "assistant" ? "assistant" : "user",
        content: String((r as any)?.content ?? "")
      }));
  }

  getMemoryStats(): { enabled: boolean; chatCount: number; noteCount: number; factCount: number } {
    if (!this.#db && !this.#fallback) return { enabled: false, chatCount: 0, noteCount: 0, factCount: 0 };
    if (!this.#db && this.#fallback) {
      return {
        enabled: true,
        chatCount: this.#fallback.chat.length,
        noteCount: this.#fallback.notes.length,
        factCount: this.#fallback.facts.length
      };
    }
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
    if (this.#db) {
      try {
        this.#db.prepare("DELETE FROM chat_messages").run();
        // Reset summary too, since it's derived from chat history.
        this.clearConversationSummary();
      } catch {}
      return;
    }
    if (!this.#fallback) return;
    this.#fallback.chat = [];
    this.clearConversationSummary();
    this.#touchFallback();
  }

  clearMemoryNotes() {
    if (this.#db) {
      try {
        this.#db.prepare("DELETE FROM memory_notes").run();
      } catch {}
      return;
    }
    if (!this.#fallback) return;
    this.#fallback.notes = [];
    this.#touchFallback();
  }

  clearMemoryFacts() {
    if (this.#db) {
      try {
        this.#db.prepare("DELETE FROM memory_facts").run();
      } catch {}
      return;
    }
    if (!this.#fallback) return;
    this.#fallback.facts = [];
    this.#touchFallback();
  }

  deleteMemoryNoteById(id: number) {
    const n = Math.floor(Number(id) || 0);
    if (!Number.isFinite(n) || n <= 0) return false;

    if (this.#db) {
      try {
        const info = this.#db.prepare("DELETE FROM memory_notes WHERE id=?").run(n);
        return Number((info as any)?.changes ?? 0) > 0;
      } catch {
        return false;
      }
    }

    if (!this.#fallback) return false;
    const before = this.#fallback.notes.length;
    this.#fallback.notes = this.#fallback.notes.filter((x) => safeInt((x as any)?.id, 0) !== n);
    const changed = this.#fallback.notes.length !== before;
    if (changed) this.#touchFallback();
    return changed;
  }

  deleteMemoryNoteByKindAndContent(kind: string, content: string) {
    const k = String(kind ?? "").trim() || "note";
    const c = String(content ?? "").trim();
    if (!c) return false;

    if (this.#db) {
      try {
        const info = this.#db.prepare("DELETE FROM memory_notes WHERE kind=? AND content=?").run(k, c);
        return Number((info as any)?.changes ?? 0) > 0;
      } catch {
        return false;
      }
    }

    if (!this.#fallback) return false;
    const before = this.#fallback.notes.length;
    this.#fallback.notes = this.#fallback.notes.filter(
      (x) => !(String((x as any)?.kind ?? "note") === k && String((x as any)?.content ?? "") === c)
    );
    const changed = this.#fallback.notes.length !== before;
    if (changed) this.#touchFallback();
    return changed;
  }

  updateMemoryNoteById(id: number, content: string, ts?: number) {
    const n = Math.floor(Number(id) || 0);
    const next = String(content ?? "").trim();
    if (!Number.isFinite(n) || n <= 0) return false;
    if (!next) return false;

    const now = Math.max(1, Math.floor(Number(ts ?? Date.now())));

    if (this.#db) {
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

    if (!this.#fallback) return false;
    const row = this.#fallback.notes.find((x) => safeInt((x as any)?.id, 0) === n);
    if (!row) return false;
    const kind = String((row as any)?.kind ?? "note").trim() || "note";
    const current = String((row as any)?.content ?? "").trim();
    if (current === next) {
      row.updated_ts = now;
      this.#touchFallback();
      return true;
    }

    const existing = this.#fallback.notes.find(
      (x) => safeInt((x as any)?.id, 0) !== n && String((x as any)?.kind ?? "note") === kind && String((x as any)?.content ?? "") === next
    );
    if (existing?.id) {
      existing.updated_ts = now;
      this.#fallback.notes = this.#fallback.notes.filter((x) => safeInt((x as any)?.id, 0) !== n);
      this.#touchFallback();
      return true;
    }

    row.content = next;
    row.updated_ts = now;
    this.#touchFallback();
    return true;
  }

  getOrInitDaily(date: string): DailyStats {
    if (!this.#db && !this.#fallback) return { date, proactive_count: 0, ignore_count: 0 };

    if (!this.#db && this.#fallback) {
      const d = String(date ?? "").trim();
      if (!d) return { date, proactive_count: 0, ignore_count: 0 };
      const existing = this.#fallback.daily[d];
      if (existing) return existing;
      const row: DailyStats = { date: d, proactive_count: 0, ignore_count: 0 };
      this.#fallback.daily[d] = row;
      this.#touchFallback();
      return row;
    }

    const sel = this.#db.prepare("SELECT date, proactive_count, ignore_count FROM daily_stats WHERE date=?");
    const row = sel.get(date) as DailyStats | undefined;
    if (row) return row;

    const ins = this.#db.prepare("INSERT INTO daily_stats(date, proactive_count, ignore_count) VALUES(?,?,?)");
    ins.run(date, 0, 0);
    return { date, proactive_count: 0, ignore_count: 0 };
  }

  incrementProactive(date: string) {
    if (!this.#db && !this.#fallback) return;
    if (!this.#db && this.#fallback) {
      const row = this.getOrInitDaily(date);
      row.proactive_count = Math.max(0, safeInt(row.proactive_count, 0) + 1);
      this.#touchFallback();
      return;
    }
    this.getOrInitDaily(date);
    const stmt = this.#db.prepare(
      "UPDATE daily_stats SET proactive_count = proactive_count + 1 WHERE date=?"
    );
    stmt.run(date);
  }

  incrementIgnore(date: string) {
    if (!this.#db && !this.#fallback) return;
    if (!this.#db && this.#fallback) {
      const row = this.getOrInitDaily(date);
      row.ignore_count = Math.max(0, safeInt(row.ignore_count, 0) + 1);
      this.#touchFallback();
      return;
    }
    this.getOrInitDaily(date);
    const stmt = this.#db.prepare("UPDATE daily_stats SET ignore_count = ignore_count + 1 WHERE date=?");
    stmt.run(date);
  }

  getDaily(date: string): DailyStats {
    if (!this.#db && !this.#fallback) return { date, proactive_count: 0, ignore_count: 0 };
    return this.getOrInitDaily(date);
  }
}
