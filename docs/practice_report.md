# SAMA（Windows Electron VRM Companion）实践报告

本文基于仓库根目录的规范 `codex_windows_electron_vrm_companion_spec.md`，对当前工程的实现状态进行对照检查，并补齐/修复影响 MVP 可用性的关键点（尤其是启动卡住/窗口全透明与 VRM 选择流程相关的问题）。

> 说明：本次实践报告以“能跑起来、能验收”为第一目标；不做 OCR / 截图 / 语音等非目标功能。

---

## 1. 目标与范围

**目标（MVP Must Work）**

- Windows-only，Electron 桌宠窗口（透明、无边框、置顶、可穿透）
- Renderer 使用 Three.js + `@pixiv/three-vrm` 渲染 `.vrm`
- 背景传感（active-win + idle time）驱动核心状态机，产生行为（APPROACH/RETREAT/INVITE_CHAT）
- 气泡窗口（独立透明窗口跟随桌宠窗口）
- 简易聊天窗口（发送/接收，LLM 或 fallback）
- LLM 支持 OpenAI / DeepSeek / AIStudio（可插拔）
- 本地 SQLite（`better-sqlite3`）记录行为/交互/每日统计

**非目标**

- macOS/Linux
- OCR、截图、屏幕分析
- TTS/语音/口型同步（项目仅做“说话”口型的轻量动画，不依赖语音）

---

## 2. 规范对照：已实现 vs 待补齐

### 2.1 Character & Window

已实现：

- **宠物窗口**：透明、无边框、置顶、跳过任务栏（`apps/stage-desktop/src/main/windows/pet.window.ts`）
- **Caption 气泡窗口**：透明、无边框、置顶、始终 click-through，跟随宠物窗口偏移（`apps/stage-desktop/src/main/windows/caption.window.ts` + `apps/stage-desktop/src/main/index.ts`）
- **Chat 窗口**：普通窗口，非置顶（`apps/stage-desktop/src/main/windows/chat.window.ts`）
- **托盘菜单**：Show/Hide、Click-through、Open Chat、Quit（`apps/stage-desktop/src/main/services/tray.service.ts`）
- **全局热键**：`Ctrl+Alt+P` 切换穿透、`Ctrl+Alt+C` 打开聊天（并额外提供 `Ctrl+Alt+O` 打开控制台）（`apps/stage-desktop/src/main/services/shortcuts.service.ts`）
- **拖拽移动窗口**：renderer 发送 drag delta，main 更新窗口坐标（`apps/stage-desktop/src/renderer/pet/ui.ts` + `apps/stage-desktop/src/main/index.ts`）

规范差异（解释）：

- spec 中写了 pet.window `resizable false`，但项目为了“用户可调窗口大小”的可用性诉求已改为可缩放（并持久化尺寸），这属于**有意偏离**（`apps/stage-desktop/src/main/windows/pet.window.ts` + `apps/stage-desktop/src/main/index.ts`）。

### 2.2 Behavior（Sensing + Core）

已实现：

- **active-win 轮询 400ms** + rolling window 统计 2 分钟切换次数、3 分钟社交 app 命中次数（`apps/stage-desktop/src/main/services/sensing.service.ts`）
- **idle time**：采用 Electron 的 `powerMonitor.getSystemIdleTime()`（Windows 友好）替代 spec 里的 `system-idle-time` 依赖（同文件）
- **核心状态机**：按 spec 优先级计算 FOCUS/IDLE/FRAGMENTED/SOCIAL_CHECK_LOOP，并实现夜间 modifier 对情绪的影响（`apps/stage-desktop/src/main/services/core.service.ts`）
- **冷却/每日上限/忽略退避**：baseCooldown=300s、dailyCap=12、ignore backoff 与“3 次后当天停用”的逻辑（同文件）
- **动作输出**：向 renderer 广播 `ActionCommand`，并在 main 侧驱动窗口 APPROACH/RETREAT 插值移动（`apps/stage-desktop/src/main/index.ts`）

### 2.3 UI（Bubble/Chat/Tray）

已实现：

- Bubble 渲染：独立窗口显示 cmd.bubble，按 durationMs 自动隐藏（`apps/stage-desktop/src/renderer/caption/*`）
- Chat 渲染：输入/历史/发送/接收（`apps/stage-desktop/src/renderer/chat/*`）
- 托盘与快捷键：见 2.1

### 2.4 LLM（OpenAI / DeepSeek / AIStudio + fallback）

已实现：

- provider interface：`generateBubble` + `chatReply`（`apps/stage-desktop/src/main/services/llm.service.ts`）
- OpenAI / DeepSeek：走 OpenAI-compatible `/chat/completions`（支持 baseUrl/model）
- AIStudio：默认走 Gemini `generateContent`，若设置 `AISTUDIO_BASE_URL` 则切换为 OpenAI-compatible
- bubble 自动截断（<=20 codepoints），失败自动降级为 rule-based

### 2.5 Memory（SQLite）

已实现：

- `events / interactions / daily_stats` 三张表（`apps/stage-desktop/src/main/services/memory.service.ts`）
- 行为、交互、每日计数写入（core 中调用）
- ABI 不匹配时自动降级内存模式，并提示 `rebuild:native`（同文件）

---

## 3. 本轮补齐/修复（面向“能用”）

### 3.1 修复：启动阶段“窗口全透明/像卡住”

**问题现象**

- 用户反馈“启动半天没有呈现任何实物/弹窗”，但鼠标到某区域会变成拖动形状（说明窗口 HTML 已加载，但 WebGL 渲染未开始）。

**根因**

- pet renderer 在旧流程里会先等待 `getVrmBytes()`（可能触发文件选择器或等待主进程响应），然后才 `scene.start()` 开始渲染。
- 当文件选择器被 always-on-top 窗口遮挡/或用户未立刻选择时，窗口看起来就是“全透明、没东西”。

**修复措施**

- pet renderer 改为**立即启动渲染**（即使 VRM 还没加载也能看到占位球体/Boot UI），并把“初次 VRM 加载”改为非阻塞流程：
  - `apps/stage-desktop/src/renderer/pet/main.ts`

### 3.2 优化：VRM 选择器不再由 `vrmGet` 隐式阻塞触发

**问题现象**

- `ipcRenderer.invoke(handle:vrm-get)` 在启动早期被调用；若主进程在 handler 内打开系统对话框，容易引发“启动等待”体验问题。

**修复措施**

- `handle:vrm-get` 改为：**只读取已配置路径**，若没有路径直接返回空 bytes（不弹对话框）。
- 文件选择器改由 `handle:vrm-pick` 显式触发（按钮/控制台/用户操作），避免“隐式阻塞”。
  - `apps/stage-desktop/src/main/index.ts`

### 3.3 新增：记住最近一次 VRM 路径

**目的**

- 用户不希望每次启动都重新选择模型；同时也不希望启动阶段强制弹出对话框。

**实现**

- 将最近一次 `vrmPick` 的路径写入 `userData/vrm-path.json`，下次启动优先加载。
  - `apps/stage-desktop/src/main/index.ts`
  - 文档说明：`README.md`

### 3.4 安全性：config.local 覆盖 + 避免提交密钥

**问题**

- `apps/stage-desktop/config.json` 容易被当作项目配置提交；如果里面放了 API Key 会造成泄漏风险。

**实现**

- 支持 `apps/stage-desktop/config.local.json`（覆盖 `config.json`），并加入 `.gitignore`，建议把密钥放在 local 文件或环境变量中。
  - 合并读取：`apps/stage-desktop/src/main/index.ts`、`apps/stage-desktop/src/main/services/sensing.service.ts`
  - ignore：`.gitignore`
  - 文档：`README.md`

### 3.5 兜底：preload API 缺失时仍可从控制台导入 VRM/VRMA

**问题现象**

- 用户曾遇到 Controls 窗口提示 `preload API 不可用：无法控制 Pet`，导致 VRM/VRMA 导入没有任何响应。

**兜底方案**

- Controls 与 Pet 两个 renderer 在 preload 不可用时，会使用 `BroadcastChannel` 建立一条“降级通道”，用于传递 `PET_CONTROL`/`PET_STATE`/`PET_STATUS`/`PET_CONTROL_RESULT`。
- 该兜底只覆盖“模型/动作导入与场景参数控制”等 renderer 内可完成的能力；涉及主进程能力（窗口穿透、窗口大小设置等）仍需要 preload IPC 正常。

---

## 4. 运行与验收建议（不依赖 IDE 配置）

### 4.1 安装

- `pnpm install`
- 若 native 依赖 ABI 不匹配：`pnpm --filter @sama/stage-desktop rebuild:native`

### 4.2 启动

- `pnpm dev`
- 首次启动如果未配置 VRM：
  - 在宠物窗口点 `选择 VRM…`，或
  - 打开控制台点 `加载 VRM…`，或
  - 直接拖拽 `.vrm` 到宠物窗口

### 4.3 关键验收点（对应 spec checklist）

- 桌面可看到 VRM 角色或占位球体（证明渲染在跑）
- 头/眼跟随鼠标（LookAt）
- 托盘/快捷键切换 click-through
- 快速切换应用触发 APPROACH + bubble
- 点击宠物触发短暂 HAPPY
- 打开 Chat 窗口能收到回复（LLM 或 fallback）

---

## 5. 已知偏差与后续建议

- idle time：当前用 Electron `powerMonitor.getSystemIdleTime()`，如需严格贴合 spec，可替换/补充 `system-idle-time`。
- 多屏支持：当前 `homePosition` 基于主显示器 workArea；后续可改为“鼠标所在屏幕”或“上次窗口所在屏幕”。
- 传输大文件：当前 VRM/VRMA 通常以 bytes 形式跨 IPC/renderer 传递；如遇超大模型，可考虑改为“路径传递 + renderer 自取”或“主进程读取 + SharedArrayBuffer/stream”。
