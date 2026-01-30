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

// Simple syntax highlighter for common tokens
function highlightCode(code: string, lang: string): React.ReactNode {
  // Common keywords by language
  const keywords: Record<string, string[]> = {
    js: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "import", "export", "from", "async", "await", "try", "catch", "throw", "new", "this", "typeof", "instanceof", "true", "false", "null", "undefined"],
    ts: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "import", "export", "from", "async", "await", "try", "catch", "throw", "new", "this", "typeof", "instanceof", "true", "false", "null", "undefined", "type", "interface", "extends", "implements", "public", "private", "protected", "readonly"],
    typescript: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "import", "export", "from", "async", "await", "try", "catch", "throw", "new", "this", "typeof", "instanceof", "true", "false", "null", "undefined", "type", "interface", "extends", "implements", "public", "private", "protected", "readonly"],
    javascript: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "import", "export", "from", "async", "await", "try", "catch", "throw", "new", "this", "typeof", "instanceof", "true", "false", "null", "undefined"],
    py: ["def", "class", "return", "if", "else", "elif", "for", "while", "import", "from", "try", "except", "raise", "with", "as", "True", "False", "None", "and", "or", "not", "in", "is", "lambda", "pass", "break", "continue", "yield", "async", "await"],
    python: ["def", "class", "return", "if", "else", "elif", "for", "while", "import", "from", "try", "except", "raise", "with", "as", "True", "False", "None", "and", "or", "not", "in", "is", "lambda", "pass", "break", "continue", "yield", "async", "await"],
    css: ["@import", "@media", "@keyframes", "@font-face", "!important"],
    html: ["DOCTYPE", "html", "head", "body", "div", "span", "script", "style", "link", "meta"],
    json: ["true", "false", "null"],
    bash: ["if", "then", "else", "fi", "for", "do", "done", "while", "case", "esac", "function", "return", "exit", "echo", "cd", "ls", "rm", "cp", "mv", "mkdir", "cat", "grep", "sed", "awk", "export"],
    sh: ["if", "then", "else", "fi", "for", "do", "done", "while", "case", "esac", "function", "return", "exit", "echo", "cd", "ls", "rm", "cp", "mv", "mkdir", "cat", "grep", "sed", "awk", "export"],
  };

  const langKeywords = keywords[lang] || keywords.js || [];

  // Simple tokenization
  const lines = code.split("\n");
  return lines.map((line, lineIdx) => {
    const tokens: React.ReactNode[] = [];
    let current = "";
    let i = 0;

    const pushCurrent = () => {
      if (current) {
        // Check if it's a keyword
        if (langKeywords.includes(current)) {
          tokens.push(<span key={`${lineIdx}-${tokens.length}`} className="hlKeyword">{current}</span>);
        } else if (/^\d+(\.\d+)?$/.test(current)) {
          tokens.push(<span key={`${lineIdx}-${tokens.length}`} className="hlNumber">{current}</span>);
        } else {
          tokens.push(current);
        }
        current = "";
      }
    };

    while (i < line.length) {
      const ch = line[i];
      const rest = line.slice(i);

      // Comments
      if (rest.startsWith("//") || rest.startsWith("#")) {
        pushCurrent();
        tokens.push(<span key={`${lineIdx}-${tokens.length}`} className="hlComment">{rest}</span>);
        break;
      }

      // Strings
      if (ch === '"' || ch === "'" || ch === "`") {
        pushCurrent();
        const quote = ch;
        let str = ch;
        i++;
        while (i < line.length) {
          const c = line[i];
          str += c;
          if (c === quote && line[i - 1] !== "\\") break;
          i++;
        }
        tokens.push(<span key={`${lineIdx}-${tokens.length}`} className="hlString">{str}</span>);
        i++;
        continue;
      }

      // Word characters
      if (/[a-zA-Z_$]/.test(ch)) {
        current += ch;
      } else if (/\d/.test(ch) && current) {
        current += ch;
      } else if (/\d/.test(ch)) {
        pushCurrent();
        current = ch;
      } else {
        pushCurrent();
        // Operators and punctuation
        if (/[{}()[\];,.:?<>=!+\-*/%&|^~]/.test(ch)) {
          tokens.push(<span key={`${lineIdx}-${tokens.length}`} className="hlPunct">{ch}</span>);
        } else {
          tokens.push(ch);
        }
      }
      i++;
    }
    pushCurrent();

    return (
      <span key={lineIdx}>
        {tokens}
        {lineIdx < lines.length - 1 ? "\n" : ""}
      </span>
    );
  });
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

  // Skip syntax highlighting for very large code blocks (> 10KB) for performance
  const MAX_HIGHLIGHT_LENGTH = 10000;
  const highlighted = useMemo(
    () => (code.length > MAX_HIGHLIGHT_LENGTH ? code : highlightCode(code, lang)),
    [code, lang]
  );

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
        <code className={`${className ?? ""} codeHighlight`}>{highlighted}</code>
      </pre>
    </div>
  );
}
