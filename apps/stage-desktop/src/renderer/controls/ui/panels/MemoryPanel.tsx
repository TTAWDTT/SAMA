import React, { useEffect, useMemo, useState } from "react";
import type { StageDesktopApi } from "../api";
import { Modal } from "../components/Modal";
import { safeString } from "../lib/utils";

type Note = { id: number; kind: string; content: string; updatedTs: number };

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
  const [notes, setNotes] = useState<Note[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);

  const [editing, setEditing] = useState<null | Note>(null);
  const [editText, setEditText] = useState("");

  async function refresh() {
    if (!api || typeof api.getMemoryStats !== "function") {
      setEnabled(false);
      setNotes([]);
      return;
    }
    setLoading(true);
    try {
      const stats = await api.getMemoryStats();
      setEnabled(Boolean(stats?.enabled));
    } catch {
      setEnabled(false);
    }

    try {
      if (!api || typeof api.listMemoryNotes !== "function") {
        setNotes([]);
        return;
      }
      const res = await api.listMemoryNotes(80);
      setNotes(Array.isArray(res?.notes) ? (res.notes as any) : []);
    } catch {
      setNotes([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter((n) => String(n.content ?? "").toLowerCase().includes(q) || String(n.kind ?? "").toLowerCase().includes(q));
  }, [notes, query]);

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
      void refresh();
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
      void refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onToast(`删除失败：${msg}`, { timeoutMs: 5200 });
    }
  }

  return (
    <div className="panel">
      <div className="panelHeader">
        <div>
          <div className="panelTitle">Memory</div>
          <div className="panelSub">“她记住了什么？”（人类可读）。</div>
        </div>
        <div className="panelMeta">{enabled ? "Enabled" : "Off"}</div>
      </div>

      <div className="card">
        <div className="row">
          <input
            className="input"
            type="text"
            placeholder="Search memory…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="btn" type="button" onClick={() => void refresh()} disabled={loading}>
            刷新
          </button>
        </div>
        <div className="help">提示：这里展示的是长期记忆 notes（不是聊天记录）。</div>
      </div>

      {filtered.length === 0 ? (
        <div className="card">
          <div className="help">{loading ? "加载中…" : "暂无记忆条目。"}</div>
        </div>
      ) : (
        <div className="memList">
          {filtered.map((n) => {
            const dots = confidenceDots(n.kind);
            const title = safeString(n.content, "—").slice(0, 22);
            return (
              <div key={n.id} className="memCard">
                <div className="memTop">
                  <div className="memTitle">{title}{title.length < safeString(n.content).length ? "…" : ""}</div>
                  <div className="memWhen">{new Date(Number(n.updatedTs ?? 0) || Date.now()).toLocaleString()}</div>
                </div>
                <div className="memSummary">{safeString(n.content)}</div>
                <div className="memMeta">
                  <span className="pill">{safeString(n.kind, "note")}</span>
                  <span className="dots" aria-label={`confidence ${dots}`}>
                    {"●".repeat(dots)}
                    <span className="dotsOff">{"●".repeat(Math.max(0, 3 - dots))}</span>
                  </span>
                </div>
                <div className="btnRow" style={{ marginTop: 10 }}>
                  <button className="btn btnSm" type="button" onClick={() => openEdit(n)}>
                    纠正
                  </button>
                  <button className="btn btnSm btnDanger" type="button" onClick={() => void deleteNote(n)}>
                    忘掉
                  </button>
                </div>
              </div>
            );
          })}
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
    </div>
  );
}

