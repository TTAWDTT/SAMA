# SAMA Agent Framework + Memory (Stage Desktop)

本文件解释 SAMA 在桌面端（`apps/stage-desktop`）的「Agent 架构」与「记忆系统」：它们分别在哪里、如何串起来、以及你要改“最佳实践”通常改哪些点。

> 目标：把 SAMA 的聊天从“单轮对话”升级为更像真正 Agent 的架构：
> - 有短期工作记忆（structured working memory）
> - 有长期记忆（可覆盖 facts + 可编辑 notes）
> - 有检索与相关性控制（fast retrieve + optional LLM rerank）
> - 有用户可控入口（UI + slash commands）
> - 有安全边界（敏感信息不写入/不注入/不 rerank）

## 1) 总览：谁在做决定？

核心决策在 Electron 主进程（main）完成，主要由 3 个 Service 组成：

- `apps/stage-desktop/src/main/services/core.service.ts`
  - 负责「状态机 + 情绪/节奏 + 行为动作 + 聊天入口」编排
  - 负责把 bubble/thinking 等 ActionCommand 广播给 pet/caption 渲染器
  - 负责“Agent loop”：记忆检索 -> 调用 LLM -> 回复 -> 后台更新记忆
- `apps/stage-desktop/src/main/services/llm.service.ts`
  - LLM provider 适配（OpenAI-compatible / DeepSeek / AIStudio Gemini）
  - fallback 规则回复保证可用性
  - 负责：
    - `chatReply()` 主对话
    - `summarizeConversation()` 维护短期摘要（working memory）
    - `extractMemoryNotes()` 提取长期记忆（facts/notes）
    - `rerankMemory()` 对候选记忆做 rerank（可选）
- `apps/stage-desktop/src/main/services/memory.service.ts`
  - 本地 SQLite：聊天记录 + 长期记忆 + KV 配置（可选；SQLite 失效则降级）
  - 提供：
    - chat history 存取
    - memory_notes / memory_facts CRUD
    - 短期摘要（kv）存取
    - 相关性检索（fast scoring）

## 2) 运行链路：从“用户输入”到“气泡/聊天回复”

1. Controls（主界面）/ QuickSend（快捷输入框）调用 preload API：
   - `apps/stage-desktop/src/main/preload.ts` 暴露 `window.stageDesktop.*`
2. 主进程接收 `handle:chat-invoke`：
   - `apps/stage-desktop/src/main/index.ts` 里 `ipcMain.handle(IPC_HANDLES.chatInvoke, ...)`
3. 主进程做两件事：
   - 立即把用户消息 append 到 chatLog（UI 立刻显示，提升响应感）
   - 调用 `core.handleChat()` 获取回复
4. `core.handleChat()`（Agent loop）：
   - 先写入 SQLite chat_messages（崩溃/重启不丢）
   - 处理 slash commands（/summary /memory /forget）
   - 构建上下文（state/mood/history + short summary + long memory）
   - 如果 LLM 启用：先发 `bubbleKind="thinking"` 的 ActionCommand（角色头旁思考动画）
   - `llm.chatReply(...)` 生成回复
   - 发 `bubbleKind="text"` 的 ActionCommand（气泡替换 thinking）
   - 异步后台：
     - 更新短期摘要（working memory）
     - 可选：自动提取长期记忆并写入（facts/notes）
5. Controls 窗口收到 chatLog 广播，渲染 timeline：
   - `apps/stage-desktop/src/renderer/controls/main.ts`

## 3) Prompt 与“人格/规则”在哪里？

- `apps/stage-desktop/src/main/agent/prompts.ts`
  - `buildBubbleSystemPrompt()`：头旁气泡用的 system prompt（超短）
  - `buildChatSystemPrompt({ summary, memory })`：主聊天回复的 system prompt
    - 注入短期摘要（working memory）
    - 注入长期记忆（facts/notes 的 prompt）

LLM provider 实际调用 prompt 的位置：
- `apps/stage-desktop/src/main/services/llm.service.ts`

你要改“人设/语气/禁止事项/格式要求”，优先改 `prompts.ts`。

## 4) 记忆系统：数据模型（SQLite）

> SAMA 的记忆是“本地优先”：写入 SQLite（可选），不会默认上云。

### 4.1 chat history（对话记录）

- 表：`chat_messages`
- 用途：
  - 重启后聊天可继续
  - 作为“recency buffer”（最近 N 条）传给 LLM

### 4.2 短期记忆：working memory（滚动摘要）

短期摘要存在 kv（便于版本化/快速读取）：

- KV：
  - `chat.summary.v1`：渲染后的“人类可读摘要文本”（注入 prompt 用）
  - `chat.summary.json.v1`：结构化 JSON（用于持续维护/后续扩展）
  - `chat.summary.lastId.v1`：摘要增量更新游标（避免重复 summarization）

摘要 schema（v1）在 `llm.service.ts` 内部解析：
- profile / preferences / goals / decisions / constraints / todos / context

### 4.3 长期记忆：durable memory

长期记忆分两类（一个可覆盖、一个可追加），对应“最佳实践”的 durable memory 分层：

1) `memory_facts`（Keyed facts，可覆盖）
- 表：`memory_facts`
- 适合存：用户名字/语言/项目名等“应该覆盖，而不是越记越多”的信息
- 特点：`key` 唯一，后写入覆盖旧 value（避免重复/发散）

2) `memory_notes`（Notes，自由笔记）
- 表：`memory_notes`
- 适合存：偏好、项目背景、长期目标等 bullet notes
- 特点：按 `(kind, content)` 去重；支持编辑/删除

## 5) 记忆检索与注入（relevance + optional rerank）

在 `core.handleChat()` 中会构建注入给 LLM 的 `memoryPrompt`，默认采用两段式：

1) 本地快速检索（fast scoring）
- `MemoryService.getRelevantMemoryFacts()` + `getRelevantMemoryNotes()`
- 根据当前 query 做 token 化 + 简单打分排序（notes 表约 400 行以内，内存打分快）

2) 可选 LLM rerank（更准，但多一次调用）
- `LLMService.rerankMemory()`
- 让 LLM 从候选条目里挑最相关的 id 列表（严格 JSON 输出）
- 通过 Memory 设置项 `llmRerank` 控制开关

> 安全：注入前会过滤疑似敏感内容，避免把 key/token 通过记忆注入或 rerank 发送给模型。

## 6) 用户可控入口（UI + slash commands）

### 6.1 Controls: Memory 面板

- `apps/stage-desktop/src/renderer/controls/ui/panels/MemoryPanel.tsx`
  - tabs：overview / summary / facts / notes / settings
  - summary：查看/复制/清空短期摘要
  - facts/notes：编辑/忘掉长期记忆
  - settings：injectLimit / summaryEnabled / llmRerank / autoRemember 等

### 6.2 Chat slash commands

在聊天里可直接使用（便于“与 agent 框架交流”）：
- `/summary`：查看短期摘要
- `/summary clear`：清空短期摘要（不删聊天记录）
- `/memory`：查看长期记忆概览（facts + notes）
- `/memory search <query>`：查看“这个 query 会注入哪些长期记忆”
- `/forget note <id>` / `/forget fact <id>`：删除指定条目

## 7) 进一步阅读（Best Practice 细节）

更完整的“最佳实践”说明、调参建议、扩展路线见：

- `docs/agent-memory-best-practice.md`

## 8) 你要继续优化，通常改哪里？

按优先级（也是最稳定的切入点）：

1) Prompt 规则：`apps/stage-desktop/src/main/agent/prompts.ts`
2) Chat/Agent loop：`apps/stage-desktop/src/main/services/core.service.ts`
3) 记忆存储与检索：`apps/stage-desktop/src/main/services/memory.service.ts`
4) Provider/summary/rerank/extract：`apps/stage-desktop/src/main/services/llm.service.ts`
5) UI 记忆管理：`apps/stage-desktop/src/renderer/controls/ui/panels/MemoryPanel.tsx`
