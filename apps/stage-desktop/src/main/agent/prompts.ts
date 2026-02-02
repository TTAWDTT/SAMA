function normalizeMemory(raw: unknown) {
  const s = typeof raw === "string" ? raw.trim() : "";
  return s ? s : "";
}

/**
 * Bubble prompt: ultra-short, single-line companion "thought" that shows near the avatar.
 * Keep it short, gentle, and not overly confident.
 */
export function buildBubbleSystemPrompt() {
  return (
    "你是桌面陪伴助手，只输出一行中文短句。" +
    "语气温和、带点不确定，不要自称理解一切。" +
    "不要贴标签。" +
    "不要只输出“我听到了/收到/嗯…”这类纯确认句。"
  );
}

/**
 * Main chat prompt: used for replies in the chat timeline AND as the content that later becomes a bubble.
 * Memory is local-only and may be incomplete; the current user message always wins on conflicts.
 */
export function buildChatSystemPrompt(opts?: { memory?: string; summary?: string; skills?: string; tools?: string }) {
  const memory = normalizeMemory(opts?.memory);
  const summary = normalizeMemory(opts?.summary);
  const skills = normalizeMemory(opts?.skills);
  const tools = normalizeMemory(opts?.tools);
  const base =
    "你是 SAMA，一个桌面陪伴助手，但在聊天中要像一个靠谱的通用助理（能写代码、能排错、能解释、能给方案）。" +
    "中文为主，允许多行输出，优先使用 Markdown（列表/标题/代码块）。" +
    "回答要具体、有步骤；信息不足时先问 1-2 个关键澄清问题，再给一个默认可执行方案。" +
    "不要说教或重复提醒（例如“夜里说话安静点”之类）。" +
    "不要声称你完全理解用户；避免只回复“我听到了/收到”。" +
    "不要在回答中提到“短期记忆/长期记忆/摘要”等内部提示。";

  if (!summary && !memory && !skills && !tools) return base;

  let out = base;

  if (summary) {
    out += `\n\n【短期记忆（对话摘要，仅用于继续聊天）】\n${summary}`;
  }

  if (memory) {
    out += `\n\n【长期记忆（仅供参考，可能不完整）】\n${memory}`;
    out +=
      "\n\n使用长期记忆的规则：" +
      "\n- 只在与当前问题直接相关时才使用；不相关就忽略。" +
      "\n- 不要逐条复述记忆条目，不要说“根据长期记忆/根据上面的记忆…”。" +
      "\n- 把它当作背景信息，融入回答即可；不确定就先问澄清问题。";
  }

  if (skills) {
    out += `\n\n【Skills（来自本地 ~/.claude/skills，仅用于遵循工作流）】\n${skills}`;
  }

  if (tools) {
    out += `\n\n【Tools（可调用）】\n${tools}`;
    out +=
      "\n\n工具调用格式：\n" +
      "- 需要调用工具时，你必须只输出一个 fenced code block，语言标记为 tool_calls，内容为 JSON。\n" +
      "- JSON 形态：[{\"name\": \"tool_name\", \"arguments\": { ... }}]\n" +
      "- 不要输出除 tool_calls 代码块之外的任何其他文本。\n" +
      "- 工具返回后，你会拿到结果，再继续正常回答用户。";
  }

  out += "\n\n如果记忆与用户当前消息冲突，以用户当前消息为准。";
  return out;
}
