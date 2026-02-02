import React, { useEffect, useMemo, useState } from "react";
import type { StageDesktopApi } from "../api";
import { Modal } from "../components/Modal";
import { safeString } from "../lib/utils";

type Note = { id: number; kind: string; content: string; updatedTs: number };
type Fact = { id: number; kind: string; key: string; value: string; updatedTs: number };
type MemoryConfig = {
  injectLimit: number;
  autoRemember: boolean;
  autoMode: "rules" | "llm";
  summaryEnabled: boolean;
  llmRerank: boolean;
};

function confidenceDots(kind: string) {
  const k = String(kind || "note").toLowerCase();
  if (k === "profile") return 3;
  if (k === "preference") return 2;
  if (k === "project") return 2;
  return 1;
}

export function MemoryPanel(props: { api: StageDesktopApi | null; onToast: (msg: string, o?: any) => void }) {
  const { api, onToast } = props;

  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<"overview" | "summary" | "facts" | "notes" | "settings">("overview");

  const [stats, setStats] = useState<{ chatCount: number; noteCount: number; factCount: number } | null>(null);
  const [cfg, setCfg] = useState<MemoryConfig>({
    injectLimit: 12,
    autoRemember: false,
    autoMode: "rules",
    summaryEnabled: true,
    llmRerank: true
  });

  const [summary, setSummary] = useState("");
  const [summaryJson, setSummaryJson] = useState<any | null>(null);

  const [facts, setFacts] = useState<Fact[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [query, setQuery] = useState("");

  const [editing, setEditing] = useState<null | Note>(null);
  const [editText, setEditText] = useState("");

  const [editingFact, setEditingFact] = useState<null | Fact>(null);
  const [editFactValue, setEditFactValue] = useState("");

  async function refreshAll() {
    if (!api || typeof api.getMemoryStats !== "function") {
      setEnabled(false);
      setStats(null);
      setFacts([]);
      setNotes([]);
      setSummary("");
      setSummaryJson(null);
      return;
    }

    setLoading(true);
    try {
      const s = await api.getMemoryStats();
      setEnabled(Boolean(s?.enabled));
      setStats({
        chatCount: Number((s as any)?.chatCount ?? 0) || 0,
        noteCount: Number((s as any)?.noteCount ?? 0) || 0,
        factCount: Number((s as any)?.factCount ?? 0) || 0
      });
    } catch {
      setEnabled(false);
      setStats(null);
    }

    try {
      if (api && typeof api.getMemoryConfig === "function") {
        const res = await api.getMemoryConfig();
        const c = res?.config as any;
        if (c && typeof c === "object") {
          setCfg((prev) => ({
            injectLimit: Number(c.injectLimit ?? prev.injectLimit) || 0,
            autoRemember: Boolean(c.autoRemember ?? prev.autoRemember),
            autoMode: c.autoMode === "llm" ? "llm" : "rules",
            summaryEnabled: c.summaryEnabled !== undefined ? Boolean(c.summaryEnabled) : prev.summaryEnabled,
            llmRerank: c.llmRerank !== undefined ? Boolean(c.llmRerank) : prev.llmRerank
          }));
        }
      }
    } catch {}

    try {
      if (api && typeof api.getMemorySummary === "function") {
        const res = await api.getMemorySummary();
        setSummary(String(res?.summary ?? ""));
        setSummaryJson((res as any)?.summaryJson ?? null);
      }
    } catch {
      setSummary("");
      setSummaryJson(null);
    }

    try {
      if (api && typeof api.listMemoryFacts === "function") {
        const res = await api.listMemoryFacts(120);
        setFacts(Array.isArray((res as any)?.facts) ? ((res as any).facts as any) : []);
      } else {
        setFacts([]);
      }
    } catch {
      setFacts([]);
    }

    try {
      if (api && typeof api.listMemoryNotes === "function") {
        const res = await api.listMemoryNotes(120);
        setNotes(Array.isArray(res?.notes) ? (res.notes as any) : []);
      } else {
        setNotes([]);
      }
    } catch {
      setNotes([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredNotes = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter((n) => String(n.content ?? "").toLowerCase().includes(q) || String(n.kind ?? "").toLowerCase().includes(q));
  }, [notes, query]);

  const filteredFacts = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return facts;
    return facts.filter(
      (f) =>
        String(f.key ?? "").toLowerCase().includes(q) ||
        String(f.value ?? "").toLowerCase().includes(q) ||
        String(f.kind ?? "").toLowerCase().includes(q)
    );
  }, [facts, query]);

  function openEdit(n: Note) {
    setEditing(n);
    setEditText(String(n.content ?? ""));
  }

  async function saveEdit() {
    if (!editing) return;
    const next = editText.trim();
    if (!next || next === editing.content) {
      setEditing(null);
      return;
    }
    if (!api || typeof api.updateMemoryNote !== "function") {
      onToast("preload API 缺失：无法编辑记忆", { timeoutMs: 4200 });
      return;
    }
    try {
      const res = await api.updateMemoryNote(editing.id, next);
      if (!res?.ok) {
        onToast("编辑失败（可能未启用本地 SQLite）", { timeoutMs: 5200 });
        return;
      }
      onToast("已更新", { timeoutMs: 1400 });
      setEditing(null);
      void refreshAll();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onToast(`编辑失败：${msg}`, { timeoutMs: 5200 });
    }
  }

  async function deleteNote(n: Note) {
    if (!api || typeof api.deleteMemoryNote !== "function") {
      onToast("preload API 缺失：无法删除记忆", { timeoutMs: 4200 });
      return;
    }
    const ok = window.confirm("忘掉这条记忆？");
    if (!ok) return;
    try {
      const res = await api.deleteMemoryNote(n.id);
      if (!res?.ok) {
        onToast("删除失败（可能未启用本地 SQLite）", { timeoutMs: 5200 });
        return;
      }
      onToast("已忘掉", { timeoutMs: 1400 });
      void refreshAll();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onToast(`删除失败：${msg}`, { timeoutMs: 5200 });
    }
  }

  function openFactEdit(f: Fact) {
    setEditingFact(f);
    setEditFactValue(String(f.value ?? ""));
  }

  async function saveFactEdit() {
    if (!editingFact) return;
    const next = editFactValue.trim();
    if (!next || next === editingFact.value) {
      setEditingFact(null);
      return;
    }
    if (!api || typeof api.updateMemoryFact !== "function") {
      onToast("preload API 缺失：无法编辑 fact", { timeoutMs: 4200 });
      return;
    }
    try {
      const res = await api.updateMemoryFact(editingFact.id, next);
      if (!res?.ok) {
        onToast("编辑失败（可能未启用本地 SQLite）", { timeoutMs: 5200 });
        return;
      }
      onToast("已更新", { timeoutMs: 1400 });
      setEditingFact(null);
      void refreshAll();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onToast(`编辑失败：${msg}`, { timeoutMs: 5200 });
    }
  }

  async function deleteFact(f: Fact) {
    if (!api || typeof api.deleteMemoryFact !== "function") {
      onToast("preload API 缺失：无法删除 fact", { timeoutMs: 4200 });
      return;
    }
    const ok = window.confirm(`忘掉这个 fact？\n\n${safeString(f.key)}: ${safeString(f.value)}`);
    if (!ok) return;
    try {
      const res = await api.deleteMemoryFact(f.id);
      if (!res?.ok) {
        onToast("删除失败（可能未启用本地 SQLite）", { timeoutMs: 5200 });
        return;
      }
      onToast("已忘掉", { timeoutMs: 1400 });
      void refreshAll();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onToast(`删除失败：${msg}`, { timeoutMs: 5200 });
    }
  }

  async function saveConfig() {
    if (!api || typeof api.setMemoryConfig !== "function") {
      onToast("preload API 缺失：无法保存 Memory 配置", { timeoutMs: 4200 });
      return;
    }
    try {
      const res = await api.setMemoryConfig(cfg as any);
      if (!res?.ok) {
        onToast("保存失败（可能未启用本地 SQLite）", { timeoutMs: 5200 });
        return;
      }
      onToast("已保存（立即生效）", { timeoutMs: 1600 });
      void refreshAll();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onToast(`保存失败：${msg}`, { timeoutMs: 5200 });
    }
  }

  return (
    <div className="panel">
      <div className="panelHeader">
        <div>
          <div className="panelTitle">Memory</div>
          <div className="panelSub">短期摘要（working memory）+ 长期记忆（facts/notes）。</div>
        </div>
        <div className="panelMeta">{enabled ? "Enabled" : "Off"}</div>
      </div>

      <div className="card">
        <div className="memTabRow">
          {([
            { id: "overview", icon: "📊", label: "概览" },
            { id: "summary", icon: "📝", label: "摘要" },
            { id: "facts", icon: "📌", label: "Facts" },
            { id: "notes", icon: "📒", label: "Notes" },
            { id: "settings", icon: "⚙️", label: "设置" }
          ] as const).map((v) => (
            <button
              key={v.id}
              className={`memTabBtn ${tab === v.id ? "isActive" : ""}`}
              type="button"
              onClick={() => setTab(v.id)}
              title={v.label}
            >
              <span className="memTabIcon">{v.icon}</span>
              <span className="memTabLabel">{v.label}</span>
            </button>
          ))}
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <input
            className="input"
            type="text"
            placeholder="Search（facts / notes）…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="btn" type="button" onClick={() => void refreshAll()} disabled={loading}>
            刷新
          </button>
        </div>
        <div className="help">
          {stats
            ? `chat=${stats.chatCount} · facts=${stats.factCount} · notes=${stats.noteCount} · injectLimit=${cfg.injectLimit}`
            : "提示：这里展示的是长期记忆（不是聊天记录）。"}
        </div>
      </div>

      {tab === "overview" ? (
        <div className="card">
          <div className="help">
            现在已经支持：
            <br />- 短期摘要：用于“继续聊下去”的工作记忆（可清空）
            <br />- 长期记忆 Facts：可覆盖的字段（例如 user.name）
            <br />- 长期记忆 Notes：自由笔记（偏好/项目背景等）
            <br />
            <br />
            你也可以在聊天里用命令：
            <br />- /summary · /summary clear
            <br />- /memory · /memory search &lt;query&gt;
            <br />- /forget note &lt;id&gt; · /forget fact &lt;id&gt;
          </div>
        </div>
      ) : tab === "summary" ? (
        <div className="card">
          <div className="field">
            <div className="label">短期摘要（working memory）</div>
            <textarea
              className="input"
              style={{ minHeight: 160, resize: "vertical", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }}
              value={safeString(summary)}
              readOnly
              spellCheck={false}
            />
            <div className="help">
              {summaryJson ? "（已存有结构化 JSON）" : "（当前为文本摘要/或尚未生成）"} · summaryEnabled=
              {String(cfg.summaryEnabled)}
            </div>
          </div>
          <div className="btnRow">
            <button
              className="btn"
              type="button"
              onClick={() => {
                const ok = (window as any).stageDesktop?.clipboardWrite?.(String(summary || ""));
                onToast(ok ? "已复制" : "复制失败", { timeoutMs: 1400 });
              }}
              disabled={!summary}
            >
              复制
            </button>
            <button
              className="btn btnDanger"
              type="button"
              onClick={async () => {
                if (!api || typeof api.clearMemorySummary !== "function") {
                  onToast("preload API 缺失：无法清空摘要", { timeoutMs: 4200 });
                  return;
                }
                const ok = window.confirm("清空短期摘要？（不会删除聊天记录）");
                if (!ok) return;
                const res = await api.clearMemorySummary();
                onToast(res?.ok ? "已清空" : "清空失败", { timeoutMs: 1600 });
                void refreshAll();
              }}
              disabled={!enabled}
            >
              清空摘要
            </button>
          </div>
        </div>
      ) : tab === "facts" ? (
        filteredFacts.length === 0 ? (
          <div className="card">
            <div className="help">{loading ? "加载中…" : "暂无 facts。"}</div>
          </div>
        ) : (
          <div className="memList">
            {filteredFacts.map((f) => {
              const title = safeString(f.key, "—");
              return (
                <div key={f.id} className="memCard">
                  <div className="memTop">
                    <div className="memTitle">{title}</div>
                    <div className="memWhen">{new Date(Number(f.updatedTs ?? 0) || Date.now()).toLocaleString()}</div>
                  </div>
                  <div className="memSummary">{safeString(f.value)}</div>
                  <div className="memMeta">
                    <span className="pill">{safeString(f.kind, "fact")}</span>
                    <div className="btnRow compact">
                      <button className="btn btnXs" type="button" onClick={() => openFactEdit(f)}>
                        纠正
                      </button>
                      <button className="btn btnXs btnDanger" type="button" onClick={() => void deleteFact(f)}>
                        忘掉
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : tab === "notes" ? (
        filteredNotes.length === 0 ? (
          <div className="card">
            <div className="help">{loading ? "加载中…" : "暂无 notes。"}</div>
          </div>
        ) : (
          <div className="memList">
            {filteredNotes.map((n) => {
              const dots = confidenceDots(n.kind);
              const title = safeString(n.content, "—").slice(0, 22);
              return (
                <div key={n.id} className="memCard">
                  <div className="memTop">
                    <div className="memTitle">
                      {title}
                      {title.length < safeString(n.content).length ? "…" : ""}
                    </div>
                    <div className="memWhen">{new Date(Number(n.updatedTs ?? 0) || Date.now()).toLocaleString()}</div>
                  </div>
                  <div className="memSummary">{safeString(n.content)}</div>
                  <div className="memMeta">
                    <div className="memMetaLeft">
                      <span className="pill">{safeString(n.kind, "note")}</span>
                      <span className="dots" aria-label={`confidence ${dots}`}>
                        {"●".repeat(dots)}
                        <span className="dotsOff">{"●".repeat(Math.max(0, 3 - dots))}</span>
                      </span>
                    </div>
                    <div className="btnRow compact">
                      <button className="btn btnXs" type="button" onClick={() => openEdit(n)}>
                        纠正
                      </button>
                      <button className="btn btnXs btnDanger" type="button" onClick={() => void deleteNote(n)}>
                        忘掉
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : (
        <div className="card">
          <div className="field">
            <div className="label">Inject limit（注入条数）</div>
            <input
              className="range"
              type="range"
              min={0}
              max={40}
              step={1}
              value={cfg.injectLimit}
              onChange={(e) => setCfg((c) => ({ ...c, injectLimit: Math.max(0, Math.min(40, Number(e.target.value) || 0)) }))}
            />
            <div className="help">{cfg.injectLimit}</div>
          </div>

          <div className="divider" />

          <div className="field">
            <div className="label">短期摘要（working memory）</div>
            <div className="row">
              <label className="pill" style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={cfg.summaryEnabled}
                  onChange={(e) => setCfg((c) => ({ ...c, summaryEnabled: e.target.checked }))}
                />
                启用
              </label>
            </div>
            <div className="help">启用后会在后台用 LLM 维护一份“对话摘要”，用于连续对话更聪明。</div>
          </div>

          <div className="field">
            <div className="label">LLM re-rank（长期记忆更准）</div>
            <div className="row">
              <label className="pill" style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                <input type="checkbox" checked={cfg.llmRerank} onChange={(e) => setCfg((c) => ({ ...c, llmRerank: e.target.checked }))} />
                启用
              </label>
            </div>
            <div className="help">启用后会额外发起一次 LLM 调用，用来挑出与当前问题最相关的记忆条目。</div>
          </div>

          <div className="divider" />

          <div className="field">
            <div className="label">Auto remember（自动写入长期记忆）</div>
            <div className="row">
              <label className="pill" style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                <input type="checkbox" checked={cfg.autoRemember} onChange={(e) => setCfg((c) => ({ ...c, autoRemember: e.target.checked }))} />
                启用
              </label>
              <select className="select" value={cfg.autoMode} onChange={(e) => setCfg((c) => ({ ...c, autoMode: e.target.value === "llm" ? "llm" : "rules" }))}>
                <option value="rules">rules</option>
                <option value="llm">llm</option>
              </select>
            </div>
            <div className="help">rules 更保守；llm 更聪明但可能更“爱记”。</div>
          </div>

          <div className="btnRow">
            <button className="btn" type="button" onClick={() => void refreshAll()} disabled={loading}>
              重新读取
            </button>
            <button className="btn btnPrimary" type="button" onClick={() => void saveConfig()} disabled={loading || !enabled}>
              保存
            </button>
          </div>

          <details className="subDetails" style={{ marginTop: 12 }}>
            <summary>Danger zone（清空）</summary>
            <div className="subDetailsBody">
              <div className="btnRow">
                <button
                  className="btn btnDanger"
                  type="button"
                  disabled={!enabled}
                  onClick={async () => {
                    if (!api || typeof api.clearMemoryNotes !== "function") return;
                    const ok = window.confirm("清空所有 notes？");
                    if (!ok) return;
                    const res = await api.clearMemoryNotes();
                    onToast(res?.ok ? "已清空 notes" : "清空失败", { timeoutMs: 1600 });
                    void refreshAll();
                  }}
                >
                  清空 notes
                </button>
                <button
                  className="btn btnDanger"
                  type="button"
                  disabled={!enabled}
                  onClick={async () => {
                    if (!api || typeof api.clearMemoryFacts !== "function") return;
                    const ok = window.confirm("清空所有 facts？");
                    if (!ok) return;
                    const res = await api.clearMemoryFacts();
                    onToast(res?.ok ? "已清空 facts" : "清空失败", { timeoutMs: 1600 });
                    void refreshAll();
                  }}
                >
                  清空 facts
                </button>
                <button
                  className="btn btnDanger"
                  type="button"
                  disabled={!enabled}
                  onClick={async () => {
                    if (!api || typeof api.clearChatHistory !== "function") return;
                    const ok = window.confirm("清空聊天记录？（会影响摘要）");
                    if (!ok) return;
                    const res = await api.clearChatHistory();
                    onToast(res?.ok ? "已清空聊天记录" : "清空失败", { timeoutMs: 1600 });
                    void refreshAll();
                  }}
                >
                  清空聊天记录
                </button>
              </div>
            </div>
          </details>
        </div>
      )}

      <Modal
        open={Boolean(editing)}
        title="纠正记忆"
        onClose={() => setEditing(null)}
        actions={
          <>
            <button className="btn" type="button" onClick={() => setEditing(null)}>
              取消
            </button>
            <button className="btn btnPrimary" type="button" onClick={() => void saveEdit()}>
              保存
            </button>
          </>
        }
      >
        <textarea
          className="input"
          style={{ minHeight: 110, resize: "vertical" }}
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          spellCheck={false}
        />
      </Modal>

      <Modal
        open={Boolean(editingFact)}
        title="纠正 Fact"
        onClose={() => setEditingFact(null)}
        actions={
          <>
            <button className="btn" type="button" onClick={() => setEditingFact(null)}>
              取消
            </button>
            <button className="btn btnPrimary" type="button" onClick={() => void saveFactEdit()}>
              保存
            </button>
          </>
        }
      >
        <div className="help" style={{ marginBottom: 8 }}>
          {safeString(editingFact?.key)}（{safeString(editingFact?.kind)}）
        </div>
        <textarea
          className="input"
          style={{ minHeight: 110, resize: "vertical" }}
          value={editFactValue}
          onChange={(e) => setEditFactValue(e.target.value)}
          spellCheck={false}
        />
      </Modal>
    </div>
  );
}
