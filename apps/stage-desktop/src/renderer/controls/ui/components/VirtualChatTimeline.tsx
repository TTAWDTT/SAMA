import React, { forwardRef, useCallback, useMemo, useRef, useState, useImperativeHandle } from "react";
import type { StageDesktopApi } from "../api";
import { JumpToBottom } from "./JumpToBottom";
import { MessageRow, type UiMessage } from "./MessageRow";
import { TypingIndicator } from "./TypingIndicator";
import { DateSeparator, formatDateSeparator, getDateKey } from "./DateSeparator";
import { ImageViewer } from "./ImageViewer";
import { VirtualList, type VirtualListHandle } from "./VirtualList";
import samaAvatar from "../assets/sama-avatar.png";

type TimelineItem =
  | { type: "date"; date: string; key: string }
  | { type: "message"; message: UiMessage; isGroupStart: boolean };

export type VirtualChatTimelineHandle = {
  scrollToBottom: (behavior?: ScrollBehavior) => void;
};

export const VirtualChatTimeline = forwardRef<
  VirtualChatTimelineHandle,
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
  }
>(function VirtualChatTimeline(props, ref) {
  const {
    api,
    llmProvider,
    onOpenLlmSettings,
    messages,
    isThinking,
    scrollLock,
    onJumpToBottom,
    onRetry,
    onToast,
    searchQuery
  } = props;

  const showLlmHint = String(llmProvider ?? "") === "fallback";
  const [viewingImage, setViewingImage] = useState<string | null>(null);
  const virtualListRef = useRef<VirtualListHandle>(null);

  // Expose scroll methods
  useImperativeHandle(ref, () => ({
    scrollToBottom: (behavior?: ScrollBehavior) => {
      virtualListRef.current?.scrollToBottom(behavior);
    }
  }), []);

  // Group messages by date for date separators and consecutive sender grouping
  const messagesWithDates = useMemo(() => {
    const result: TimelineItem[] = [];
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

      const isGroupStart = isNewDate || lastRole !== m.role || (m.ts - lastTs > GROUP_GAP_MS);

      result.push({ type: "message", message: m, isGroupStart });
      lastRole = m.role;
      lastTs = m.ts;
    }
    return result;
  }, [messages]);

  // Get item key for virtualization
  const getItemKey = useCallback((item: TimelineItem, index: number): string => {
    if (item.type === "date") {
      return item.key;
    }
    return item.message.id;
  }, []);

  // Render each item
  const renderItem = useCallback(
    (item: TimelineItem, index: number) => {
      if (item.type === "date") {
        return <DateSeparator date={item.date} />;
      }
      return (
        <MessageRow
          api={api}
          message={item.message}
          isGroupStart={item.isGroupStart}
          onToast={onToast}
          onRetry={onRetry}
          searchQuery={searchQuery}
          onViewImage={setViewingImage}
        />
      );
    },
    [api, onToast, onRetry, searchQuery]
  );

  // Handle scroll for auto-scroll behavior
  const handleScroll = useCallback(
    (scrollTop: number, scrollHeight: number, clientHeight: number) => {
      // This could be used to detect scroll position for scroll lock
      // Currently handled externally via onJumpToBottom
    },
    []
  );

  return (
    <div className="timelineWrap">
      {showLlmHint && (
        <div className="hintBanner" role="note">
          <div className="hintTitle">未配置 LLM</div>
          <div className="hintText">
            当前聊天使用离线规则回复，效果会很差。请在侧边栏「LLM」里配置 API Key（或使用本地 Ollama）。
          </div>
          {onOpenLlmSettings && (
            <button className="btn btnSm btnPrimary" type="button" onClick={onOpenLlmSettings}>
              打开 LLM 设置
            </button>
          )}
        </div>
      )}

      {messages.length === 0 ? (
        <div className="timeline" role="log" aria-live="polite">
          <div className="emptyState">
            <div className="emptyIcon">
              <img src={samaAvatar} alt="SAMA" />
            </div>
            <div className="emptyTitle">SAMA</div>
            <div className="emptyDesc">开始对话吧，我会记住我们的每一次交流。</div>
          </div>
        </div>
      ) : (
        <VirtualList
          ref={virtualListRef}
          className="timeline"
          items={messagesWithDates}
          estimatedItemHeight={80}
          overscan={5}
          getItemKey={getItemKey}
          renderItem={renderItem}
          onScroll={handleScroll}
        />
      )}

      {isThinking && (
        <div className="typingIndicatorFixed">
          <TypingIndicator />
        </div>
      )}

      {scrollLock && <JumpToBottom onClick={onJumpToBottom} />}

      <ImageViewer src={viewingImage} onClose={() => setViewingImage(null)} />
    </div>
  );
});
