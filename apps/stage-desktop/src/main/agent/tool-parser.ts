/**
 * Tool call parser: extracts tool_calls from LLM responses
 */

type ParsedToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export type ParseResult = {
  hasToolCalls: boolean;
  toolCalls: ParsedToolCall[];
  textBefore: string;
  textAfter: string;
};

/**
 * Parse tool calls from LLM response text.
 * Expected format:
 * ```tool_calls
 * [{"name": "tool_name", "arguments": {...}}]
 * ```
 */
export function parseToolCalls(text: string): ParseResult {
  const result: ParseResult = {
    hasToolCalls: false,
    toolCalls: [],
    textBefore: "",
    textAfter: ""
  };

  if (!text || typeof text !== "string") {
    return result;
  }

  // Match ```tool_calls ... ``` blocks
  const toolCallRegex = /```tool_calls\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  const textParts: string[] = [];

  while ((match = toolCallRegex.exec(text)) !== null) {
    // Capture text before this match
    if (match.index > lastIndex) {
      textParts.push(text.slice(lastIndex, match.index));
    }

    const jsonContent = match[1].trim();
    try {
      const parsed = JSON.parse(jsonContent);
      const calls = Array.isArray(parsed) ? parsed : [parsed];

      for (const call of calls) {
        if (call && typeof call === "object" && typeof call.name === "string") {
          result.toolCalls.push({
            name: call.name,
            arguments: call.arguments && typeof call.arguments === "object" ? call.arguments : {}
          });
        }
      }
    } catch (err) {
      // Invalid JSON, skip this block
      console.warn("[tool-parser] Failed to parse tool_calls JSON:", err);
    }

    lastIndex = match.index + match[0].length;
  }

  // Capture remaining text after last match
  if (lastIndex < text.length) {
    textParts.push(text.slice(lastIndex));
  }

  result.hasToolCalls = result.toolCalls.length > 0;

  // Split text parts into before and after
  const combinedText = textParts.join("").trim();
  if (result.hasToolCalls) {
    // If we have tool calls, the text before is everything up to first match
    const firstMatch = text.match(/```tool_calls/);
    if (firstMatch && firstMatch.index !== undefined) {
      result.textBefore = text.slice(0, firstMatch.index).trim();
      // Find end of last tool_calls block
      let lastEnd = 0;
      toolCallRegex.lastIndex = 0;
      while ((match = toolCallRegex.exec(text)) !== null) {
        lastEnd = match.index + match[0].length;
      }
      result.textAfter = text.slice(lastEnd).trim();
    }
  } else {
    result.textBefore = combinedText;
  }

  return result;
}

/**
 * Format tool results for injection into conversation
 */
export function formatToolResults(results: { name: string; ok: boolean; content: string }[]): string {
  if (!results.length) return "";

  const lines: string[] = ["【工具执行结果】"];
  for (const r of results) {
    lines.push(`\n[${r.name}] ${r.ok ? "成功" : "失败"}`);
    lines.push(r.content);
  }
  return lines.join("\n");
}
