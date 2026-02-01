# SAMA 记忆系统（重点说明）

本文聚焦 SAMA 的“记忆”：分层、写入、注入、检索与安全策略，并说明 UI/命令如何管理。

## 记忆分层（用途不同）

SAMA 的“记忆”可以理解为三层：

1) **对话历史（Chat History）**
- 作用：保持短期对话连续性（例如最近 20-40 轮）。
- 载体：内存中的 `history` +（可选）本地持久化（SQLite）。
- 使用位置：每次 LLM 调用会带上 `ctx.history`（通常截取最近一段）。

2) **短期摘要（Summary / Working Memory）**
- 作用：把长对话压缩成更稳定的“继续聊天所需上下文”。
- 生成：由 LLM 按固定 JSON schema 维护更新（可配置开启），并做节流避免频繁更新。
- 注入：作为 system prompt 中的“短期记忆”区块（但不在回复里提这些术语）。
- 维护命令：
  - `/summary` 查看
  - `/summary clear` 清空

3) **长期记忆（Durable Memory）**
- 作用：跨会话持久保存“稳定、未来还成立”的信息（偏好、项目背景、用户信息等）。
- 形态：
  - **facts**：key/value（适合可覆盖的稳定事实，例如 `user.name`）
  - **notes**：自由文本（适合无法结构化但稳定的信息）
- 注入：在每次回复前，会检索并拼出 `memoryPrompt` 注入 system prompt 的“长期记忆”区块。

## 写入路径

### A) 用户手动写入（强信号）

用户可用明确指令让 SAMA 记住某事：
- `记住: ...` / `记一下: ...` / `记下来: ...`
- `/remember ...`

这类写入通常直接进入长期记忆（notes 或被规范化为 fact）。

### B) 自动写入（弱信号，需要保守）

当开启 Auto remember 时，SAMA 会在回复结束后后台执行：
- 更新短期摘要（summary）
-（可选）使用 LLM 提取“适合长期记住”的候选项（extract）
- 将候选项写入长期记忆（facts/notes），并做去重/白名单 key/长度裁剪等

## 注入与检索（回答前发生）

每次处理用户消息时，会执行“相关记忆注入”：
1) 从 MemoryService 取候选 facts/notes（按关键词/打分排序）
2) 过滤敏感内容（防泄露，见下节）
3) 按 injectLimit 预算挑选（facts 与 notes 分配一定比例）
4) 可选：用 LLM rerank（对候选集合重排再截取）
5) 形成 `memoryPrompt` 并注入 system prompt

调试/查看命令：
- `/memory search <query>`：输出与 query 相关的长期记忆提示块
- `/memory clear notes|facts|all`：清空长期记忆
- `/forget note <id>` / `/forget fact <id>`：删除单条

## 安全策略：敏感信息处理

SAMA 在记忆链路上做了保守防护（避免把 token/密码等写入或注入 LLM）：
- 判断函数（示例）：`looksSensitiveText(...)`
- 规则：
  - 发现敏感内容：不写入长期记忆
  - 记忆注入时：过滤敏感字段
  - 摘要生成时：对敏感文本进行脱敏替换（避免摘要带出机密）

## UI 与配置

Controls -> Memory 面板可视化管理长期记忆与摘要（增删改查、统计、清理等）。

Controls -> LLM 面板包含与“Agent 能力”相关的配置项（例如 Web Search 开关、skills 注入等），这些能力会影响“回答前上下文的构建方式”，进而影响记忆使用效果。

