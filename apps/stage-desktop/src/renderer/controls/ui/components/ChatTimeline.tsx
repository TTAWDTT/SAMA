import type { ChatLogEntry } from "@sama/shared";
import React, { forwardRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { formatTime } from "../lib/utils";

export const ChatTimeline = forwardRef<HTMLDivElement, { entries: ChatLogEntry[]; isThinking: boolean }>(
  function ChatTimeline(props, ref) {
    const { entries, isThinking } = props;

    return (
      <div ref={ref} className="timeline" role="log" aria-live="polite">
        {entries.length === 0 ? (
          <div className="empty">
            <div className="emptyTitle">SAMA</div>
            <div className="emptyDesc">单会话。没有会话列表。直接开始聊。</div>
          </div>
        ) : (
          entries.map((e) => (
            <div key={e.id || `${e.ts}_${e.role}`} className={`msgRow ${e.role}`}>
              <div className={`msg ${e.role}`}>
                <div className="msgHeader">
                  <div className="msgWho">{e.role === "user" ? "You" : "Her"}</div>
                  <div className="msgTime">{formatTime(e.ts)}</div>
                </div>
                <div className="msgBody markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{e.content}</ReactMarkdown>
                </div>
              </div>
            </div>
          ))
        )}

        {isThinking ? (
          <div className="typingRow" aria-label="Typing">
            <div className="typingDot" />
            <div className="typingDot" />
            <div className="typingDot" />
            <div className="typingText">Typing…</div>
          </div>
        ) : null}
      </div>
    );
  }
);

