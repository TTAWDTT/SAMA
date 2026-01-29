export function stripMarkdown(md: string) {
  const s = String(md ?? "");

  // Links: [text](url) -> text
  let out = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Fenced code blocks: keep code content, drop fences
  out = out.replace(/```[a-z0-9_-]*\n([\s\S]*?)```/gi, "$1");

  // Inline code: `x` -> x
  out = out.replace(/`([^`]+)`/g, "$1");

  // Headings: ### Title -> Title
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, "");

  // Blockquotes: > x -> x
  out = out.replace(/^\s{0,3}>\s?/gm, "");

  // List markers: - x / * x / 1. x -> x
  out = out.replace(/^\s{0,3}([-*]|\d+\.)\s+/gm, "");

  // Emphasis markers
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
  out = out.replace(/\*([^*]+)\*/g, "$1");
  out = out.replace(/__([^_]+)__/g, "$1");
  out = out.replace(/_([^_]+)_/g, "$1");

  return out.trim();
}

