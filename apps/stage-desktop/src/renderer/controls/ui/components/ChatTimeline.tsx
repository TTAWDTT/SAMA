import React, { forwardRef } from "react";
import type { StageDesktopApi } from "../api";
import { JumpToBottom } from "./JumpToBottom";
import { MessageRow, type UiMessage } from "./MessageRow";
import { TypingIndicator } from "./TypingIndicator";
import samaAvatar from "../assets/sama-avatar.png";

export const ChatTimeline = forwardRef<
  HTMLDivElement,
  {
    api: StageDesktopApi | null;
    llmProvider?: string;
    onOpenLlmSettings?: () => void;
    messages: UiMessage[];
    isThinking: boolean;
    scrollLock: boolean;
    onJumpToBottom: () => void;
    onRetry?: (text: string) => void;
    onToast?: (msg: string, o?: any) => void;
  }
>(function ChatTimeline(props, ref) {
  const { api, llmProvider, onOpenLlmSettings, messages, isThinking, scrollLock, onJumpToBottom, onRetry, onToast } = props;
  const showLlmHint = String(llmProvider ?? "") === "fallback";

  return (
    <div className="timelineWrap">
      <div ref={ref} className="timeline" role="log" aria-live="polite">
        {showLlmHint ? (
          <div className="hintBanner" role="note">
            <div className="hintTitle">未配置 LLM</div>
            <div className="hintText">当前聊天使用离线规则回复，效果会很差。请在侧边栏「LLM」里配置 API Key（或使用本地 Ollama）。</div>
            {onOpenLlmSettings ? (
              <button className="btn btnSm btnPrimary" type="button" onClick={onOpenLlmSettings}>
                打开 LLM 设置
              </button>
            ) : null}
          </div>
        ) : null}

        {messages.length === 0 ? (
          <div className="emptyState">
            <div className="emptyIcon">
              <img src={samaAvatar} alt="SAMA" />
            </div>
            <div className="emptyTitle">SAMA</div>
            <div className="emptyDesc">
              开始对话吧，我会记住我们的每一次交流。
            </div>
          </div>
        ) : (
          <div className="messageList">
            {messages.map((m) => (
              <MessageRow key={m.id} api={api} message={m} onToast={onToast} onRetry={onRetry} />
            ))}
          </div>
        )}

        {isThinking && <TypingIndicator />}
      </div>

      {scrollLock && <JumpToBottom onClick={onJumpToBottom} />}
    </div>
  );
});
