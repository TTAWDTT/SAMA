# Agent Architecture + Memory (Best Practice) - SAMA Stage Desktop

> 这份文档给你一个“可扩展、可调试、可控”的 Agent 架构与记忆系统说明，针对当前 `apps/stage-desktop` 代码实现。
>
> 目标：
> - 让聊天具备连续性（短期工作记忆）
> - 让长期偏好/事实可被记住并可编辑（长期记忆）
> - 让记忆注入相关且可控（检索 + rerank）
> - 让用户能看见并管理记忆（UI + 命令）
> - 让系统避免“脏记忆/敏感信息泄露”

## 1. 组件与职责

主进程（Electron main）是 Agent 的“决策脑”，核心模块：

- `apps/stage-desktop/src/main/services/core.service.ts`
  - Chat/Action 总编排（Agent loop）
  - 负责：保存消息 -> 取记忆 -> 调用 LLM -> 回写记忆 -> 派发动作/气泡
- `apps/stage-desktop/src/main/services/llm.service.ts`
  - Provider 适配层（OpenAI-compatible / DeepSeek / Gemini）
  - 负责：chatReply / summarizeConversation / extractMemoryNotes / rerankMemory
- `apps/stage-desktop/src/main/services/memory.service.ts`
  - 本地 SQLite（可选；不可用时降级）
  - 负责：chat_history、summary KV、memory_facts、memory_notes、config KV
- `apps/stage-desktop/src/main/agent/prompts.ts`
  - Prompt 统一入口：chat prompt / bubble prompt

渲染层（renderer）负责“表现层”：

- Pet renderer：`apps/stage-desktop/src/renderer/pet/*`
  - 渲染 VRM，计算 head anchor 等
- Caption renderer：`apps/stage-desktop/src/renderer/caption/*`
  - 渲染 bubble / thinking，不遮挡脸
- Controls UI：`apps/stage-desktop/src/renderer/controls/ui/*`
  - 主聊天、设置、Memory 面板

## 2. Chat Agent Loop（核心流程）

从用户输入到回复/气泡的关键链路：

1) Controls / QuickSend 调用 preload API（`window.stageDesktop.chatInvoke`）
2) Main 进程 `IPC_HANDLES.chatInvoke`：
   - 立即 append chatLog（让 UI 先显示用户消息）
   - 调用 `core.handleChat(req)`
3) `core.handleChat()` 做：
   - 保存 user message 到 `chat_messages`
   - 解析 slash 命令（/summary /memory /forget 等）
   - 记忆检索：构建 `memoryPrompt`（facts+notes）+ `summary`
   - 发出 `bubbleKind="thinking"`（LLM 进行中给反馈）
   - 调用 `llm.chatReply(ctx, userMsg)` 获取回复
   - 写入 assistant message 到 `chat_messages`
   - 发出 `bubbleKind="text"`，替换 thinking
   - 异步后台任务：
     - 更新短期摘要（working memory）
     - 可选：自动抽取长期记忆并写入（facts/notes）

## 3. 记忆模型（Best Practice 分层）

SAMA 当前采用三层：

### 3.1 Recency buffer（最近对话）
- 来源：内存 `#chatHistory`（从 SQLite 恢复最近 40 条）
- 发送给模型：provider 内部截断为最近 20 条（避免 token 爆炸）

### 3.2 Short-term working memory（短期工作记忆）
- 存储：SQLite `kv`
  - `chat.summary.v1`：渲染后的摘要文本（注入 prompt）
  - `chat.summary.json.v1`：结构化 JSON（用于持续维护）
  - `chat.summary.lastId.v1`：增量游标
- 更新：`LLMService.summarizeConversation()`（后台异步，不阻塞回复）
- Schema（v1）：
  - `profile / preferences / goals / decisions / constraints / todos / context`

### 3.3 Long-term durable memory（长期记忆）
分成两种存储形态：

1) `memory_facts`（可覆盖）
- 适合：名字/语言/项目名等“应该覆盖而不是重复”的信息
- Unique：`key` 唯一，后写入覆盖旧 value

2) `memory_notes`（自由笔记）
- 适合：偏好/项目背景/长期目标等 bullet note
- Unique：`(kind, content)` 去重

## 4. 记忆检索与注入（Relevance + Optional Rerank）

### 4.1 本地相关性检索（fast）
`MemoryService` 做 token + in-memory scoring：
- 适合小表（notes <= 400）
- 速度快、可离线

### 4.2 LLM rerank（可选）
当候选条目明显多于 `injectLimit` 时，可额外调用一次 LLM 做“重排”：
- 输入：query + candidate facts/notes（带 id）
- 输出：严格 JSON `{ "facts":[id...], "notes":[id...] }`
- 好处：更贴题，减少“随机注入”
- 代价：一次额外 LLM 调用（可在 UI 关闭）

### 4.3 安全过滤
注入前会过滤疑似敏感内容，避免把 key/token 通过记忆注入或 rerank 发送给模型。

## 5. 记忆写入与合并（减少脏记忆）

### 5.1 手动写入
- `记住: ...` / `/remember ...`：写入 `memory_notes`
- 若内容疑似敏感（key/token/password），拒绝写入

### 5.2 自动写入（autoRemember）
两种模式：
- `rules`：保守规则抽取（稳定但覆盖范围小）
- `llm`：LLM 抽取（更聪明，但需防脏）

LLM 抽取允许输出：
- keyed fact：`{"kind":"profile|preference|project|note","key":"user.name","value":"..."}`
- note：`{"kind":"...","content":"..."}`

合并策略要点：
- facts：key allowlist（防止无限造 key 污染 DB）
- preferences：简单冲突处理（喜欢/不喜欢互斥）

## 6. 用户可控入口（强 UX）

### 6.1 Memory 面板（Controls）
`MemoryPanel` 提供分 tab 管理：
- overview / summary / facts / notes / settings
- summary：可复制、可清空
- facts/notes：可编辑、可删除
- settings：injectLimit / summaryEnabled / llmRerank / autoRemember 等

### 6.2 Slash commands
聊天内可用：
- `/summary` 查看短期摘要
- `/summary clear` 清空短期摘要
- `/memory` 查看长期记忆概览
- `/memory search <query>` 查看“当前 query 会注入哪些长期记忆”
- `/forget note <id>` / `/forget fact <id>` 删除指定条目

## 7. 调参建议（默认最佳实践）

推荐：
- `summaryEnabled = true`（强烈建议）
- `injectLimit = 10~16`（太大容易偏题/浪费 tokens）
- `llmRerank = true`（追求质量；若你更在意延迟/成本可关）
- `autoRemember = false` 默认保守；需要更“像人”再开
- `autoMode = rules` 更稳；需要更聪明再换 `llm`

## 8. 扩展路线（下一阶段）

如果要继续逼近“更强 Agent”：
- 结构化工具调用（tool router + tool executor）
- embedding/RAG（向量检索长期记忆与历史片段）
- 记忆评估/回归测试（golden prompts + deterministic scoring）
- 记忆过期/TTL（避免旧偏好干扰新行为）

