# SAMA Agent 架构（概览）

本文介绍 SAMA 的整体 Agent 架构：进程/窗口划分、核心服务分层、IPC 数据流，以及一次“用户发消息 -> 得到回复 -> 角色反馈”的完整链路。

## 进程与窗口

SAMA 是一个 Electron 桌面应用（pnpm workspace：`apps/stage-desktop` 为桌面端）。运行时主要由主进程 + 多个渲染进程（窗口）组成：

- Pet（宠物窗口）：透明置顶，负责 VRM 渲染、VRMA 播放、气泡锚点等。
  - 代码：`apps/stage-desktop/src/renderer/pet/*`
- Caption（字幕气泡层）：透明置顶，负责显示 “thinking / bubble” 文本。
  - 代码：`apps/stage-desktop/src/renderer/caption/*`
- Controls（控制台/主 UI）：React UI，聊天时间线、LLM 配置、动作面板、记忆面板等。
  - 代码：`apps/stage-desktop/src/renderer/controls/ui/*`
- Chat（快捷输入）：极简输入框窗口，用于快捷发消息。
  - 代码：`apps/stage-desktop/src/renderer/chat/*`

主进程负责创建窗口、装配服务、处理 IPC（入口：`apps/stage-desktop/src/main/index.ts`）。

## 核心分层

### CoreService（“Agent 大脑”）
位置：`apps/stage-desktop/src/main/services/core.service.ts`

职责：
- 接收用户输入/交互事件，维护内部状态（mood/energy/state 等）。
- 组织上下文（历史、记忆注入、摘要、skills 等）并调用 LLM。
- 产生 ActionCommand（表情/气泡/行为）驱动角色反馈。
- 提供斜杠命令（`/summary`、`/memory ...`、`/search`、`/web`、`/skill ...`）。

### LLMService（模型接入层）
位置：`apps/stage-desktop/src/main/services/llm.service.ts`

职责：
- 统一对不同 Provider（OpenAI/DeepSeek/AIStudio）的调用（含超时、错误处理）。
- 输出 chat reply（用于聊天 UI）与 bubble（短气泡句）。
- 支持：对话摘要更新、长期记忆提取、记忆候选重排（rerank）。

### MemoryService（本地记忆/日志）
位置：`apps/stage-desktop/src/main/services/memory.service.ts`

职责：
- 本地 SQLite（可用时）持久化 chat/action/facts/notes/summary 等。
- 提供检索与注入能力（相关记忆 prompt、历史恢复、统计、清理等）。

### SkillService（本地 skills 注入）
位置：`apps/stage-desktop/src/main/services/skill.service.ts`

职责：
- 从 `~/.claude/skills`（或 UI 指定目录）扫描每个子目录下的 `SKILL.md`。
- 将勾选的 skills 以文本块形式注入 system prompt（只影响后续对话）。

### Web Search（联网搜索）
位置：`apps/stage-desktop/src/main/services/web-search.service.ts`

职责：
- 提供 Tavily 搜索封装。
- 通过 `/search` 与 `/web` 命令给 Agent “先搜再答”的能力（受 UI 开关控制）。

## IPC / Preload（主进程与 UI 桥）

- preload：`apps/stage-desktop/src/main/preload.ts`
  - 将 IPC 封装成 `window.stageDesktop.*` 供渲染端使用
- IPC 常量与类型：`packages/shared`
  - 频道/句柄：`IPC_CHANNELS`、`IPC_HANDLES`
  - schemas/types：用于跨进程的消息结构一致性

## 一次完整链路：用户消息 -> 回复 -> 角色反馈

1) 用户在 Controls 或 Chat 输入消息
- 渲染端通过 preload API 调用 `chatInvoke(...)`
- 进入主进程后交由 CoreService 处理

2) CoreService 组织上下文并调用 LLM
- 组装 `ctx`：state/isNight/mood/history/memory/summary/skills
- 先发送 “thinking” 的 `ActionCommand` 给 Pet/Caption（让用户知道在思考）
- 调用 `LLMService.chatReply(ctx, userMsg)`

3) 回复落地与展示
- 将 user/assistant 消息写入 MemoryService（可持久化）
- 将回复作为 ChatResponse 返回给 UI 时间线
- 同时生成 `bubble`（通常取回复的第一段）并发送 `ActionCommand`：
  - Caption 负责气泡显示（优先）；Pet 侧内联气泡仅兜底

## 相关文档

- `docs/agent-framework.md`
- `docs/agent-memory-best-practice.md`
- `docs/sama-memory.md`
- `docs/sama-vrm-vrma.md`

