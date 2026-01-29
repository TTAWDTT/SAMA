# SAMA Agent Framework (Stage Desktop)

本文件用来解释 SAMA 在桌面端（`apps/stage-desktop`）的「Agent 框架」是什么、在哪、怎么改。

## 1) 总览：谁在做决定？

SAMA 的核心决策在主进程（Electron main）里完成，主要由三个 Service 组成：

- `apps/stage-desktop/src/main/services/core.service.ts`
  - 负责「状态机 + 情绪/节奏 + 行为动作 + 聊天入口」的编排
  - 会把动作/气泡（ActionCommand）广播给 pet/caption 渲染器
- `apps/stage-desktop/src/main/services/llm.service.ts`
  - LLM Provider 适配层（OpenAI-compatible / Gemini）
  - LLM 不可用时自动 fallback 到规则回复（确保可用性）
- `apps/stage-desktop/src/main/services/memory.service.ts`
  - 本地 SQLite：聊天记录与长期记忆（notes）持久化

## 2) 运行链路：从“用户输入”到“气泡/聊天回复”

1. Controls（主界面）/ QuickSend（快捷输入框）调用 preload API：
   - `apps/stage-desktop/src/main/preload.ts` 暴露 `window.stageDesktop.*`
2. 主进程接收 `handle:chat-invoke`：
   - `apps/stage-desktop/src/main/index.ts` 里 `ipcMain.handle(IPC_HANDLES.chatInvoke, ...)`
3. 主进程做两件事：
   - 立即把用户消息 append 到 chatLog（UI 立刻显示，提升响应感）
   - 调用 `core.handleChat()` 获取回复
4. `core.handleChat()`：
   - 写入 SQLite 聊天记录（崩溃/重启也不会丢）
   - 如果 LLM 启用，先发一个 `bubbleKind="thinking"` 的 ActionCommand（角色头旁小动画）
   - 调用 `llm.chatReply(...)` 生成回复
   - 发 `bubbleKind="text"` 的 ActionCommand（气泡替换掉 thinking）
5. Controls 窗口收到 chatLog 广播：
   - `apps/stage-desktop/src/renderer/controls/main.ts` 渲染 timeline

## 3) Agent Prompt 在哪里？

为了便于你直接修改「人格/语气/规则」，prompt 被集中放在这里：

- `apps/stage-desktop/src/main/agent/prompts.ts`
  - `buildBubbleSystemPrompt()`：角色头旁“气泡”提示的 system prompt
  - `buildChatSystemPrompt({ memory })`：主聊天回复 system prompt（会注入长期记忆）

LLM Provider 调用 prompt 的位置：

- `apps/stage-desktop/src/main/services/llm.service.ts`

你想改“人设/回复风格/禁止事项”，直接改 `prompts.ts` 最稳定。

## 4) 长期记忆（Long-term Memory）机制

长期记忆分两层：

1) 聊天记录持久化（chat history）
- 表：`chat_messages`
- 用途：重启后聊天记录还能继续；也作为短期 history 传给 LLM（最近 N 条）

2) Durable notes（长期记忆条目）
- 表：`memory_notes`
- 用途：存“偏好/事实/长期信息”，用 bullet list 注入到 system prompt
- 写入方式：
  - 在聊天里发送：`记住: ...` / `记一下: ...` / `/remember ...`
  - 或在 Controls 设置页「长期记忆」里手动添加

对应实现：
- `apps/stage-desktop/src/main/services/memory.service.ts`
  - `upsertMemoryNote() / listMemoryNotes() / getMemoryPrompt()`
- `apps/stage-desktop/src/main/services/core.service.ts`
  - `parseRememberNote()`：解析“记住: …”
  - `ctx.memory = memory.getMemoryPrompt(12)`：注入 prompt

## 5) 你要“与框架交流”通常改哪里？

常见改动入口（按优先级）：

1. 改 agent prompt：`apps/stage-desktop/src/main/agent/prompts.ts`
2. 改什么时候 show thinking / bubble：`apps/stage-desktop/src/main/services/core.service.ts`
3. 改记忆写入/清空策略：`apps/stage-desktop/src/main/services/memory.service.ts`
4. 改 LLM provider 或消息格式：`apps/stage-desktop/src/main/services/llm.service.ts`

如果你希望后续把“记忆自动抽取（从对话里总结偏好）”也做掉，通常会在 `core.handleChat()` 回复后增加一个「提取记忆」步骤（可以用 LLM 或规则），并写入 `memory_notes`。

