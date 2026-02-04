import React, { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { StageDesktopApi } from "../api";
import { CodeBlock } from "./CodeBlock";

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

function trimEmptyEdgeLines(lines: string[]) {
  let start = 0;
  let end = lines.length;
  while (start < end && !String(lines[start] ?? "").trim()) start++;
  while (end > start && !String(lines[end - 1] ?? "").trim()) end--;
  return lines.slice(start, end);
}

function toInlineCodeSpan(text: string) {
  const s = String(text ?? "");
  const runs = s.match(/`+/g) ?? [];
  const maxRun = runs.reduce((m, r) => Math.max(m, r.length), 0);
  const fence = "`".repeat(Math.max(1, maxRun + 1));
  const needsPadding = s.startsWith("`") || s.endsWith("`");
  const inner = needsPadding ? ` ${s} ` : s;
  return `${fence}${inner}${fence}`;
}

function normalizeLiteCodeFences(input: string) {
  // Some models sometimes output "``" fenced blocks. That's not valid Markdown fencing, but we still want to display it
  // in a readable way (without the heavy fenced-code UI we use for normal ``` blocks).
  const src = String(input ?? "").replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  const out: string[] = [];

  let inFence: null | { char: "`" | "~"; size: number } = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmedStart = line.replace(/^\s{0,3}/, "");

    if (inFence) {
      out.push(line);
      const close = trimmedStart.match(inFence.char === "`" ? /^(`{3,})\s*$/ : /^(~{3,})\s*$/);
      if (close && close[1]!.length >= inFence.size) inFence = null;
      continue;
    }

    const open = trimmedStart.match(/^(`{3,}|~{3,})/);
    if (open?.[1]) {
      inFence = { char: open[1][0] as any, size: open[1].length };
      out.push(line);
      continue;
    }

    // "``" fenced block start (optional language after it is ignored on purpose).
    const liteStart = trimmedStart.match(/^``(?:\s*[a-z0-9_-]+)?\s*$/i);
    if (!liteStart) {
      out.push(line);
      continue;
    }

    const body: string[] = [];
    let closedAt = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const nextLine = lines[j] ?? "";
      const nextTrimmedStart = nextLine.replace(/^\s{0,3}/, "");
      if (/^``\s*$/.test(nextTrimmedStart)) {
        closedAt = j;
        break;
      }
      body.push(nextLine);
    }

    if (closedAt < 0) {
      // Unclosed "``" start; keep as-is.
      out.push(line);
      continue;
    }

    const trimmedBody = trimEmptyEdgeLines(body);
    if (trimmedBody.length === 1) {
      const codeLine = String(trimmedBody[0] ?? "").trim();
      if (!codeLine) {
        i = closedAt;
        continue;
      }

      // For one-liners, render as an inline code span so it can live naturally in the sentence flow.
      const span = toInlineCodeSpan(codeLine);

      const prevIdx = out.length - 1;
      const prev = prevIdx >= 0 ? String(out[prevIdx] ?? "") : "";
      if (prev.trim()) {
        const prevTrimEnd = prev.replace(/\s+$/, "");
        const last = prevTrimEnd.slice(-1);
        const noSpaceAfter = new Set([":", "：", "（", "(", "【", "["]);
        const hasTrailingWs = prevTrimEnd.length !== prev.length;
        const joiner = hasTrailingWs ? "" : noSpaceAfter.has(last) ? "" : " ";
        out[prevIdx] = prev + joiner + span;
      } else {
        out.push(span);
      }

      i = closedAt;
      continue;
    }

    out.push("```sama-lite");
    out.push(...body);
    out.push("```");
    i = closedAt;
  }

  return out.join("\n");
}

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

export const Markdown = React.memo(function Markdown(props: { api: StageDesktopApi | null; content: string; onToast?: (m: string, o?: any) => void }) {
  const { api, content, onToast } = props;
  const normalizedContent = useMemo(() => normalizeLiteCodeFences(content), [content]);

  const components = useMemo(
    () => ({
      a: ({ href, children }: any) => (
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
      pre: ({ children }: any) => <>{children}</>,
      // react-markdown v10 doesn't type `inline`, but it is present at runtime.
      code: (p: any) => {
        const { node, className, children, ...rest } = p ?? {};
        const text = extractText(children);

        // react-markdown v10 (with remark-rehype) represents both inline and block code as a <code> element.
        // We infer "block" by either:
        // - having a language-* class (fenced code), OR
        // - containing newlines (indented or fenced code without a language).
        const nodeClass = node && typeof node === "object" ? (node as any).properties?.className : undefined;
        const nodeClassStr = Array.isArray(nodeClass) ? nodeClass.map(String).join(" ") : typeof nodeClass === "string" ? nodeClass : "";
        const classStr = typeof className === "string" ? className : "";
        const isBlock = /\blanguage-/.test(classStr) || /\blanguage-/.test(nodeClassStr) || text.includes("\n");

        if (!isBlock) return <code {...rest}>{children}</code>;

        const lang = normalizeLanguage(classStr || nodeClassStr);
        if (lang === "sama-lite") {
          const code = text.replace(/\n$/, "");
          return (
            <div className="codeLiteBlock" role="group" aria-label="code">
              <code className="codeLite">{code}</code>
            </div>
          );
        }
        return (
          <CodeBlock api={api} className={className} onToast={onToast}>
            {children}
          </CodeBlock>
        );
      }
    }),
    [api, onToast]
  );

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={components}
    >
      {normalizedContent}
    </ReactMarkdown>
  );
});
