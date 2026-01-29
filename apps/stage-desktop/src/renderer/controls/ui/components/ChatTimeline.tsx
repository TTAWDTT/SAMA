import React, { forwardRef } from "react";
import type { StageDesktopApi } from "../api";
import { JumpToBottom } from "./JumpToBottom";
import { MessageRow, type UiMessage } from "./MessageRow";
import { TypingIndicator } from "./TypingIndicator";

export const ChatTimeline = forwardRef<
  HTMLDivElement,
  {
    api: StageDesktopApi | null;
    messages: UiMessage[];
    isThinking: boolean;
    scrollLock: boolean;
    onJumpToBottom: () => void;
    onRetry?: (text: string) => void;
    onToast?: (msg: string, o?: any) => void;
  }
>(function ChatTimeline(props, ref) {
  const { api, messages, isThinking, scrollLock, onJumpToBottom, onRetry, onToast } = props;

  return (
    <div className="timelineWrap">
      <div ref={ref} className="timeline" role="log" aria-live="polite">
        {messages.length === 0 ? (
          <div className="empty">
            <div className="emptyTitle">SAMA</div>
            <div className="emptyDesc">单会话。没有会话列表。直接开始聊。</div>
          </div>
        ) : (
          messages.map((m) => (
            <MessageRow key={m.id} api={api} message={m} onToast={onToast} onRetry={onRetry} />
          ))
        )}

        {isThinking ? <TypingIndicator /> : null}
      </div>

      {scrollLock ? <JumpToBottom onClick={onJumpToBottom} /> : null}
    </div>
  );
});
