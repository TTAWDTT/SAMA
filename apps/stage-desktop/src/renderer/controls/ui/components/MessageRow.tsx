import type { ChatLogEntry } from "@sama/shared";
import React, { useCallback, useMemo, useState } from "react";
import type { StageDesktopApi } from "../api";
import { formatTime, writeClipboard } from "../lib/utils";
import { stripMarkdown } from "../lib/stripMarkdown";
import { Markdown } from "./Markdown";
import samaAvatar from "../assets/sama-avatar.png";

export type MessageImage = {
  dataUrl: string;
  name?: string;
};

export type UiMessage = ChatLogEntry & {
  status?: "sent" | "error";
  errorMessage?: string;
  retryText?: string;
  images?: MessageImage[];
};

// Copy icon SVG
function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

// Check icon SVG
function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

// Retry icon SVG
function RetryIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 2v6h-6" />
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M3 22v-6h6" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  );
}

function SpeakIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  );
}

export const MessageRow = React.memo(function MessageRow(props: {
  api: StageDesktopApi | null;
  message: UiMessage;
  isGroupStart?: boolean;
  onToast?: (msg: string, o?: any) => void;
  onRetry?: (text: string) => void;
  searchQuery?: string;
  onViewImage?: (src: string) => void;
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}) {
  const { api, message, isGroupStart = true, onToast, onRetry, searchQuery, onViewImage, selectionMode, selected, onToggleSelect } = props;
  const [copied, setCopied] = useState<null | "text" | "md">(null);
  const [hovered, setHovered] = useState(false);

  const plainText = useMemo(() => stripMarkdown(message.content), [message.content]);
  const isAssistant = message.role === "assistant";
  const isUser = message.role === "user";
  const isError = message.status === "error";
  const hasImages = message.images && message.images.length > 0;
  const tools = message.meta?.tools ?? [];
  const skills = message.meta?.skills ?? [];
  const hasMeta = tools.length > 0 || skills.length > 0;

  // Check if this message matches the search
  const isSearchMatch = searchQuery && message.content.toLowerCase().includes(searchQuery.toLowerCase());

  const copyText = async (kind: "text" | "md") => {
    const text = kind === "md" ? message.content : plainText;
    const ok = await writeClipboard(api, text);
    if (ok) {
      onToast?.("已复制", { timeoutMs: 1200, type: "success" });
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1500);
    } else {
      onToast?.("复制失败", { timeoutMs: 2400, type: "error" });
    }
  };

  const speak = () => {
    if (!api?.sendPetControl) {
      onToast?.("preload API 缺失：无法朗读", { timeoutMs: 2400, type: "error" });
      return;
    }
    const text = String(message.content ?? "").trim();
    if (!text) return;
    api.sendPetControl({ type: "PET_CONTROL", ts: Date.now(), action: "SPEAK_TEXT", text } as any);
  };

  const handleSelect = useCallback(() => {
    onToggleSelect?.(message.id);
  }, [onToggleSelect, message.id]);

  return (
    <div
      id={`msg-${message.id}`}
      className={`chatMessage ${message.role} ${isError ? "hasError" : ""} ${isSearchMatch ? "searchMatch" : ""} ${!isGroupStart ? "isGrouped" : ""} ${selectionMode ? "selectionMode" : ""}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={selectionMode ? handleSelect : undefined}
      style={selectionMode ? { cursor: "pointer", opacity: selected ? 1 : 0.6 } : undefined}
    >
      {selectionMode && (
        <div className={`selectCheckbox ${selected ? "checked" : ""}`}>
          {selected && <CheckIcon />}
        </div>
      )}

      {/* Avatar - only show for assistant (SAMA) and only on group start */}
      {isAssistant && (
        <div className={`chatAvatar ${!isGroupStart ? "hidden" : ""}`}>
          <img src={samaAvatar} alt="SAMA" className="avatarImg" />
        </div>
      )}

      {/* Message bubble */}
      <div className="chatBubble">
        {/* Time - show above bubble only on group start */}
        {isGroupStart && <div className="chatTime">{formatTime(message.ts)}</div>}

        {/* Meta tags (tools/skills) */}
        {isUser && hasMeta && (
          <div className="chatMetaTags">
            {tools.map((name) => (
              <span key={`tool:${name}`} className="selectedTag tool" title={`Tool: ${name}`}>
                <span className="selectedTagType">T</span>
                <span className="selectedTagName">{name}</span>
              </span>
            ))}
            {skills.map((name) => (
              <span key={`skill:${name}`} className="selectedTag skill" title={`Skill: ${name}`}>
                <span className="selectedTagType">S</span>
                <span className="selectedTagName">{name}</span>
              </span>
            ))}
          </div>
        )}

        {/* Images */}
        {hasImages && (
          <div className="chatImages">
            {message.images!.map((img, i) => (
              <img
                key={i}
                src={img.dataUrl}
                alt={img.name || `图片 ${i + 1}`}
                className="chatImage"
                onClick={() => onViewImage?.(img.dataUrl)}
              />
            ))}
          </div>
        )}

        {/* Bubble content */}
        {message.content && (
          <div className={`bubbleContent ${isAssistant ? "markdown" : ""}`}>
            {isAssistant ? (
              <Markdown api={api} content={message.content} onToast={onToast} />
            ) : (
              <p className="userText">{message.content}</p>
            )}
          </div>
        )}

        {/* Error badge and message */}
        {isError && (
          <div className="chatErrorWrap">
            <span className="chatErrorBadge">发送失败</span>
            {message.errorMessage && (
              <span className="chatErrorMsg">{message.errorMessage}</span>
            )}
          </div>
        )}

        {/* Action buttons - show on hover */}
        <div className={`chatActions ${hovered ? "visible" : ""}`}>
          <button
            className="chatActionBtn"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void copyText("text");
            }}
            aria-label="复制"
            title="复制文本"
          >
            {copied === "text" ? <CheckIcon /> : <CopyIcon />}
          </button>

          {isAssistant && (
            <button
              className="chatActionBtn"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void copyText("md");
              }}
              aria-label="复制Markdown"
              title="复制为Markdown"
            >
              {copied === "md" ? <CheckIcon /> : <span className="actionLabel">MD</span>}
            </button>
          )}

          {isAssistant && !isError && (
            <button
              className="chatActionBtn"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                speak();
              }}
              aria-label="朗读"
              title="朗读（第一段）"
            >
              <SpeakIcon />
            </button>
          )}

          {isError && message.retryText && onRetry && (
            <button
              className="chatActionBtn retry"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRetry(message.retryText!);
              }}
              aria-label="重试"
              title="重试"
            >
              <RetryIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
