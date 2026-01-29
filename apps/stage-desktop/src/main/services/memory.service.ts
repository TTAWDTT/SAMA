import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ActionCommand, ChatLogEntry, UserInteraction } from "@sama/shared";

export type MemoryServiceOpts = {
  dbPath: string;
};

type DailyStats = { date: string; proactive_count: number; ignore_count: number };
type ChatRow = { id: number; ts: number; role: "user" | "assistant"; content: string };

const CHAT_RETENTION_LIMIT = 2000;

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
    `);
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
