import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ActionCommand, ChatLogEntry, UserInteraction } from "@sama/shared";

export type MemoryServiceOpts = {
  dbPath: string;
};

type DailyStats = { date: string; proactive_count: number; ignore_count: number };
type ChatRow = { id: number; ts: number; role: "user" | "assistant"; content: string };
type MemoryNoteRow = { id: number; created_ts: number; updated_ts: number; kind: string; content: string };

const CHAT_RETENTION_LIMIT = 2000;
const NOTE_RETENTION_LIMIT = 400;
const DEFAULT_AGENT_MEMORY_CONFIG = { injectLimit: 12, autoRemember: false, autoMode: "rules" as const };

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

  getAgentMemoryConfig(): { injectLimit: number; autoRemember: boolean; autoMode: "rules" | "llm" } {
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

    return { injectLimit, autoRemember, autoMode };
  }

  setAgentMemoryConfig(
    partial: any
  ): { ok: boolean; config: { injectLimit: number; autoRemember: boolean; autoMode: "rules" | "llm" } } {
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
          : prev.autoMode
    } as const;

    try {
      this.#setKv("memory.injectLimit", String(next.injectLimit));
      this.#setKv("memory.autoRemember", next.autoRemember ? "1" : "0");
      this.#setKv("memory.autoMode", next.autoMode);
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
    const n = Math.max(0, Math.min(200, Math.floor(Number(limit) || 0)));
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

  getMemoryPrompt(limit: number): string {
    const notes = this.listMemoryNotes(limit);
    if (!notes.length) return "";
    const lines: string[] = [];
    for (const n of notes) {
      const kind = n.kind && n.kind !== "note" ? `(${n.kind}) ` : "";
      lines.push(`- ${kind}${n.content}`);
    }
    return lines.join("\n");
  }

  getMemoryStats(): { enabled: boolean; chatCount: number; noteCount: number } {
    if (!this.#db) return { enabled: false, chatCount: 0, noteCount: 0 };
    try {
      const chat = this.#db.prepare("SELECT COUNT(1) AS n FROM chat_messages").get() as { n?: number } | undefined;
      const notes = this.#db.prepare("SELECT COUNT(1) AS n FROM memory_notes").get() as { n?: number } | undefined;
      return { enabled: true, chatCount: Number(chat?.n ?? 0) || 0, noteCount: Number(notes?.n ?? 0) || 0 };
    } catch {
      return { enabled: true, chatCount: 0, noteCount: 0 };
    }
  }

  clearChatHistory() {
    if (!this.#db) return;
    try {
      this.#db.prepare("DELETE FROM chat_messages").run();
    } catch {}
  }

  clearMemoryNotes() {
    if (!this.#db) return;
    try {
      this.#db.prepare("DELETE FROM memory_notes").run();
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
