import React, { forwardRef, useMemo, useState } from "react";
import type { StageDesktopApi } from "../api";
import { JumpToBottom } from "./JumpToBottom";
import { MessageRow, type UiMessage } from "./MessageRow";
import { TypingIndicator } from "./TypingIndicator";
import { DateSeparator, formatDateSeparator, getDateKey } from "./DateSeparator";
import { ImageViewer } from "./ImageViewer";
import samaAvatar from "../assets/sama-avatar.png";

export const ChatTimeline = React.memo(forwardRef<
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
    searchQuery?: string;
    selectionMode?: boolean;
    selectedIds?: Set<string>;
    onToggleSelect?: (id: string) => void;
    bottomRef?: React.RefObject<HTMLDivElement | null>;
  }
>(function ChatTimeline(props, ref) {
  const { api, llmProvider, onOpenLlmSettings, messages, isThinking, scrollLock, onJumpToBottom, onRetry, onToast, searchQuery, selectionMode, selectedIds, onToggleSelect, bottomRef } = props;
  const showLlmHint = String(llmProvider ?? "") === "fallback";
  const [viewingImage, setViewingImage] = useState<string | null>(null);
  const largeList = messages.length >= 120;

  // Group messages by date for date separators and consecutive sender grouping
  // isGroupStart: true if this message starts a new group (different sender or time gap > 2 min)
  const messagesWithDates = useMemo(() => {
    const result: Array<{ type: "date"; date: string; key: string } | { type: "message"; message: UiMessage; isGroupStart: boolean }> = [];
    let lastDateKey = "";
    let lastRole: string | null = null;
    let lastTs = 0;
    const GROUP_GAP_MS = 2 * 60 * 1000; // 2 minutes

    for (const m of messages) {
      const dateKey = getDateKey(m.ts);
      const isNewDate = dateKey !== lastDateKey;

      if (isNewDate) {
        result.push({
          type: "date",
          date: formatDateSeparator(m.ts),
          key: `date-${dateKey}`
        });
        lastDateKey = dateKey;
      }

      // Check if this is the start of a new message group
      const isGroupStart = isNewDate || lastRole !== m.role || (m.ts - lastTs > GROUP_GAP_MS);

      result.push({ type: "message", message: m, isGroupStart });
      lastRole = m.role;
      lastTs = m.ts;
    }
    return result;
  }, [messages]);

  // Keep the bottom part always rendered even when using `content-visibility` for long histories,
  // so "jump to bottom" can land reliably without layout settling.
  const END_ZONE_ITEMS = 44;
  const endZoneFrom = Math.max(0, messagesWithDates.length - END_ZONE_ITEMS);

  return (
    <div className="timelineWrap">
      <div
        ref={ref}
        className="timeline"
        role="log"
        aria-live="polite"
        aria-busy={isThinking}
        data-large-list={largeList ? "1" : "0"}
      >
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
            {messagesWithDates.map((item, idx) =>
              item.type === "date" ? (
                <DateSeparator key={item.key} date={item.date} className={largeList && idx >= endZoneFrom ? "cvEndZone" : ""} />
              ) : (
                <MessageRow
                  key={item.message.id}
                  api={api}
                  message={item.message}
                  isGroupStart={item.isGroupStart}
                  cvEndZone={largeList && idx >= endZoneFrom}
                  onToast={onToast}
                  onRetry={onRetry}
                  searchQuery={searchQuery}
                  onViewImage={setViewingImage}
                  selectionMode={selectionMode}
                  selected={selectedIds?.has(item.message.id)}
                  onToggleSelect={onToggleSelect}
                />
              )
            )}
          </div>
        )}

        {isThinking && <TypingIndicator />}

        <div ref={bottomRef} className="timelineBottomSentinel" aria-hidden="true" />
      </div>

      {scrollLock && <JumpToBottom onClick={onJumpToBottom} />}

      <ImageViewer src={viewingImage} onClose={() => setViewingImage(null)} />
    </div>
  );
}));
