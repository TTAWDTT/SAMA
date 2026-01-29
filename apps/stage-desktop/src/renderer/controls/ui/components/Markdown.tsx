import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { StageDesktopApi } from "../api";
import { CodeBlock } from "./CodeBlock";

function sanitizeExternalUrl(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  // Disallow javascript: and other dangerous schemes.
  try {
    const u = new URL(s);
    const proto = u.protocol.toLowerCase();
    if (proto === "http:" || proto === "https:" || proto === "mailto:") return u.toString();
    return null;
  } catch {
    // Not an absolute URL (relative links are not supported in our app).
    return null;
  }
}

async function openExternal(api: StageDesktopApi | null, href: string) {
  const safe = sanitizeExternalUrl(href);
  if (!safe) return false;
  if (api && typeof api.openExternal === "function") {
    try {
      const ok = await api.openExternal(safe);
      return Boolean(ok);
    } catch {
      // fall through
    }
  }
  try {
    window.open(safe, "_blank", "noopener,noreferrer");
    return true;
  } catch {
    return false;
  }
}

export function Markdown(props: { api: StageDesktopApi | null; content: string; onToast?: (m: string, o?: any) => void }) {
  const { api, content, onToast } = props;

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => (
          <a
            href={href}
            onClick={(e) => {
              e.preventDefault();
              void (async () => {
                const ok = await openExternal(api, String(href ?? ""));
                if (!ok) onToast?.("无法打开链接（已阻止不安全 URL）", { timeoutMs: 2400 });
              })();
            }}
          >
            {children}
          </a>
        ),
        // react-markdown v10 doesn't type `inline`, but it is present at runtime.
        code: (p: any) => {
          const { inline, className, children, ...rest } = p ?? {};
          if (inline) return <code {...rest}>{children}</code>;
          return (
            <CodeBlock api={api} className={className} onToast={onToast}>
              {children}
            </CodeBlock>
          );
        }
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
