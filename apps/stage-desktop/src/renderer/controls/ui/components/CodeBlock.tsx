import React, { useMemo, useState } from "react";
import type { StageDesktopApi } from "../api";

function extractText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (children && typeof children === "object" && "props" in (children as any)) {
    return extractText((children as any).props?.children);
  }
  return "";
}

function normalizeLanguage(className: string | undefined) {
  const raw = String(className ?? "");
  const m = raw.match(/language-([a-z0-9_-]+)/i);
  if (!m?.[1]) return "";
  return m[1].toLowerCase();
}

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

export function CodeBlock(props: {
  api: StageDesktopApi | null;
  className?: string;
  children?: React.ReactNode;
  onToast?: (msg: string, o?: any) => void;
}) {
  const { api, className, children, onToast } = props;
  const [copied, setCopied] = useState(false);
  const lang = useMemo(() => normalizeLanguage(className), [className]);
  const code = useMemo(() => extractText(children).replace(/\n$/, ""), [children]);

  return (
    <div className="codeBlock">
      <div className="codeBlockTop">
        <div className="codeLang">{lang || "code"}</div>
        <button
          className="miniBtn"
          type="button"
          aria-label="Copy code"
          onClick={() => {
            void (async () => {
              const ok = await writeClipboard(api, code);
              if (ok) {
                onToast?.("已复制", { timeoutMs: 1200 });
                setCopied(true);
                window.setTimeout(() => setCopied(false), 900);
              } else {
                onToast?.("复制失败", { timeoutMs: 2400 });
              }
            })();
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="codePre">
        <code className={className}>{code}</code>
      </pre>
    </div>
  );
}

