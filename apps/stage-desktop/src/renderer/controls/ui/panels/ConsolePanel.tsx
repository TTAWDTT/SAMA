import React, { useEffect, useMemo, useRef, useState } from "react";
import { formatTime, isNearBottom, scrollToBottom } from "../lib/utils";

export type AppLogItem = {
  ts: number;
  level: "info" | "warn" | "error";
  message: string;
  scope?: string;
};

export function ConsolePanel(props: { logs: AppLogItem[]; onClear: () => void }) {
  const { logs, onClear } = props;

  const [level, setLevel] = useState<"all" | AppLogItem["level"]>("all");
  const [query, setQuery] = useState("");
  const [tail, setTail] = useState(true);

  const listRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => {
      stickRef.current = isNearBottom(el, 120);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (!tail) return;
    if (stickRef.current) scrollToBottom(el);
  }, [logs, tail]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return logs.filter((x) => {
      if (level !== "all" && x.level !== level) return false;
      if (!q) return true;
      const s = `${x.scope ?? ""} ${x.message ?? ""}`.toLowerCase();
      return s.includes(q);
    });
  }, [logs, level, query]);

  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  const copyLog = async (log: AppLogItem) => {
    const text = `[${formatTime(log.ts)}] [${log.level.toUpperCase()}]${log.scope ? ` [${log.scope}]` : ""} ${log.message}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopyFeedback(log.ts.toString());
      setTimeout(() => setCopyFeedback(null), 1500);
    } catch {}
  };

  return (
    <div className="panel">
      <div className="panelHeader">
        <div>
          <div className="panelTitle">Developer Console</div>
          <div className="panelSub">主进程日志（可过滤/搜索）。</div>
        </div>
        <div className="panelMeta">{filtered.length} / {logs.length}</div>
      </div>

      <div className="card consoleControls">
        <div className="consoleControlsRow">
          <select className="select selectSm" value={level} onChange={(e) => setLevel(e.target.value as any)}>
            <option value="all">all</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>

          <input
            className="input inputSm"
            type="text"
            placeholder="搜索日志…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          <button className="btn btnSm" type="button" onClick={onClear}>
            清空
          </button>
        </div>

        <label className="switchRow">
          <input type="checkbox" checked={tail} onChange={(e) => setTail(Boolean(e.target.checked))} />
          <span className="switchLabel">实时跟踪</span>
        </label>
      </div>

      <div ref={listRef} className="logList" role="log" aria-label="Logs">
        {filtered.length === 0 ? (
          <div className="emptyLog">暂无日志。</div>
        ) : (
          filtered.map((l, idx) => (
            <div
              key={`${l.ts}_${idx}`}
              className={`logRow ${l.level} ${idx % 2 === 0 ? "even" : "odd"} ${copyFeedback === l.ts.toString() ? "copied" : ""}`}
              onClick={() => void copyLog(l)}
              title="点击复制"
            >
              <div className="logMeta">
                <span className="logTime">{formatTime(l.ts)}</span>
                <span className={`logLevel ${l.level}`}>{l.level}</span>
                {l.scope ? <span className="logScope">{l.scope}</span> : null}
              </div>
              <div className="logMsg">{l.message}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

