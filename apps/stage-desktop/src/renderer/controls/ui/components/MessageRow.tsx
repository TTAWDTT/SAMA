import type { ChatLogEntry } from "@sama/shared";
import React, { useMemo, useState } from "react";
import type { StageDesktopApi } from "../api";
import { formatTime } from "../lib/utils";
import { stripMarkdown } from "../lib/stripMarkdown";
import { Markdown } from "./Markdown";

export type UiMessage = ChatLogEntry & {
  status?: "sent" | "error";
  errorMessage?: string;
  // When provided, shows a retry button that re-sends this text.
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
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    return false;
  }
}

export function MessageRow(props: {
  api: StageDesktopApi | null;
  message: UiMessage;
  onToast?: (msg: string, o?: any) => void;
  onRetry?: (text: string) => void;
}) {
  const { api, message, onToast, onRetry } = props;
  const [copied, setCopied] = useState<null | "text" | "md">(null);

  const roleLabel = message.role === "user" ? "你" : "她";

  const plainText = useMemo(() => stripMarkdown(message.content), [message.content]);
  const isAssistant = message.role === "assistant";
  const isError = message.status === "error";

  const copyText = async (kind: "text" | "md") => {
    const text = kind === "md" ? message.content : plainText;
    const ok = await writeClipboard(api, text);
    if (ok) {
      onToast?.("已复制", { timeoutMs: 1200 });
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 900);
    } else {
      onToast?.("复制失败", { timeoutMs: 2400 });
    }
  };

  return (
    <div className={`msgRow ${message.role}`}>
      <div className="msgRowInner">
        <div className={`msg ${message.role} ${isError ? "isError" : ""}`}>
          <div className="msgHeader">
            <div className="msgHeaderLeft">
              <div className="msgWho">{roleLabel}</div>
              <div className="msgTime">{formatTime(message.ts)}</div>
              {isError ? <div className="msgTag">error</div> : null}
            </div>
          </div>

          <div className="msgActions" aria-label="Message actions">
            <button
              className="miniBtn"
              type="button"
              aria-label="Copy message"
              onClick={() => void copyText("text")}
            >
              {copied === "text" ? "Copied" : "Copy"}
            </button>
            {isAssistant ? (
              <button
                className="miniBtn"
                type="button"
                aria-label="Copy as markdown"
                onClick={() => void copyText("md")}
              >
                {copied === "md" ? "Copied" : "MD"}
              </button>
            ) : null}
            {isAssistant && isError && message.retryText && onRetry ? (
              <button
                className="miniBtn miniBtnWarn"
                type="button"
                aria-label="Retry"
                onClick={() => onRetry(message.retryText!)}
              >
                重试
              </button>
            ) : null}
          </div>

          <div className={`msgBody ${isAssistant ? "markdown" : "plain"}`}>
            {isAssistant ? (
              <Markdown api={api} content={message.content} onToast={onToast} />
            ) : (
              <span>{message.content}</span>
            )}
          </div>

          {isError ? <div className="msgErrorLine">{message.errorMessage || "请求失败"}</div> : null}
        </div>
      </div>
    </div>
  );
}

