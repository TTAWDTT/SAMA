import type { ChatLogEntry } from "@sama/shared";
import React, { useMemo, useState } from "react";
import type { StageDesktopApi } from "../api";
import { formatTime } from "../lib/utils";
import { stripMarkdown } from "../lib/stripMarkdown";
import { Markdown } from "./Markdown";
import samaAvatar from "../assets/sama-avatar.png";

export type UiMessage = ChatLogEntry & {
  status?: "sent" | "error";
  errorMessage?: string;
  retryText?: string;
};

async function writeClipboard(api: StageDesktopApi | null, text: string) {
  const t = String(text ?? "");
  if (!t) return false;
  if (api && typeof api.clipboardWrite === "function") {
    try {
      return Boolean(api.clipboardWrite(t));
    } catch {
      // fall through
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

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

export function MessageRow(props: {
  api: StageDesktopApi | null;
  message: UiMessage;
  onToast?: (msg: string, o?: any) => void;
  onRetry?: (text: string) => void;
}) {
  const { api, message, onToast, onRetry } = props;
  const [copied, setCopied] = useState<null | "text" | "md">(null);
  const [hovered, setHovered] = useState(false);

  const plainText = useMemo(() => stripMarkdown(message.content), [message.content]);
  const isAssistant = message.role === "assistant";
  const isUser = message.role === "user";
  const isError = message.status === "error";

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

  return (
    <div
      className={`chatMessage ${message.role} ${isError ? "hasError" : ""}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Avatar - only show for assistant (SAMA) */}
      {isAssistant && (
        <div className="chatAvatar">
          <img src={samaAvatar} alt="SAMA" className="avatarImg" />
        </div>
      )}

      {/* Message bubble */}
      <div className="chatBubble">
        {/* Time - show above bubble */}
        <div className="chatTime">{formatTime(message.ts)}</div>

        {/* Bubble content */}
        <div className={`bubbleContent ${isAssistant ? "markdown" : ""}`}>
          {isAssistant ? (
            <Markdown api={api} content={message.content} onToast={onToast} />
          ) : (
            <p className="userText">{message.content}</p>
          )}
        </div>

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
            onClick={() => void copyText("text")}
            aria-label="复制"
            title="复制文本"
          >
            {copied === "text" ? <CheckIcon /> : <CopyIcon />}
          </button>

          {isAssistant && (
            <button
              className="chatActionBtn"
              type="button"
              onClick={() => void copyText("md")}
              aria-label="复制Markdown"
              title="复制为Markdown"
            >
              {copied === "md" ? <CheckIcon /> : <span className="actionLabel">MD</span>}
            </button>
          )}

          {isError && message.retryText && onRetry && (
            <button
              className="chatActionBtn retry"
              type="button"
              onClick={() => onRetry(message.retryText!)}
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
}
