# SAMA — Windows Electron VRM Companion Spec

本文件是本仓库的“实现规范”（living spec），用于描述 **SAMA** 的 MVP 功能范围、窗口结构、IPC 约定、以及验收要点。

> 目标：先把 **能跑、能用、可验收** 的 Windows 桌宠链路做稳定，再逐步扩展能力（TTS/OCR/更复杂动作系统等）。

---

## 1. 范围

**平台**：Windows 10/11（仅此平台）

**核心能力（MVP）**

- Electron 桌宠窗口：透明/无边框/置顶/可点击穿透
- VRM 渲染：Three.js + `@pixiv/three-vrm`
- 动作：
  - 程序 Idle（呼吸/摆动 + “手臂自然下垂”姿态修正）
  - 程序 Walk（窗口移动/拖拽时切换）
  - 支持 `.vrma` 动作：可加载并设为 Idle/Walk 槽位，或作为一次性 ACTION 播放
- 行为系统：active-win + idle time 传感 → 核心状态机 → 输出行为（APPROACH/RETREAT/INVITE_CHAT…）
- 对话：独立输入窗口发送；回复以气泡显示在角色附近
- 存储：SQLite（`better-sqlite3`），ABI 不匹配自动降级为内存模式（不阻塞渲染）

**非目标**

- macOS / Linux
- OCR / 屏幕分析
- 真正的语音 TTS + 口型同步（MVP 仅做简易“说话”口型权重动画）

---

## 2. 工程结构

- `apps/stage-desktop/`：Electron 应用（main/preload/renderer）
- `packages/shared/`：共享类型、schema、IPC 常量
- `docs/`：实践报告等

---

## 3. 窗口模型（Windows）

### 3.1 Pet Window（桌宠窗口）

要求：

- `transparent: true`、`frame: false`、`alwaysOnTop: true`、`skipTaskbar: true`
- 支持 click-through：`setIgnoreMouseEvents(true, { forward: true })`
- **允许缩放**（为满足“用户可调窗口大小”的需求）

交互：

- 左键拖动：移动窗口（通过 preload IPC 发 drag delta → main 设置 position）
- Shift + 左键拖动：平移角色（调整角色在窗口内位置）
- 右键拖动：旋转视角（Orbit）

### 3.2 Controls Window（控制台）

要求：

- 独立窗口（不与角色展示固定在一起）
- 能完成：导入 VRM/VRMA、设 Idle/Walk 槽位、窗口大小、模型 transform、Idle/Walk 参数调节、动作库（自定义命名）

### 3.3 Chat Window（对话输入）

要求：

- 独立窗口
- 专门用于输入与发送（Enter 发送，Shift+Enter 换行）
- **回复不在 chat window 展示**，而在角色旁气泡展示

### 3.4 Caption Bubble（气泡）

要求：

- 气泡显示在角色附近（基于 head bone 投影锚点）
- 气泡应保证可见（必要时自动翻转为“在锚点下方”，并做边界夹取）

---

## 4. IPC 约定

IPC 常量来自：`packages/shared/src/constants.ts`

### 4.1 Handles（ipcMain.handle）

- `handle:vrm-get`：返回 VRM bytes（启动阶段不弹出系统对话框；无路径返回空 bytes）
- `handle:vrm-pick`：打开文件选择器并返回 VRM bytes（同时持久化路径）
- `handle:chat-invoke`：发送 ChatRequest，返回 ChatResponse（并在 main 侧派发 bubble ActionCommand）

### 4.2 Channels（ipcRenderer.send / webContents.send）

- `bus:action-command`：main → pet/caption（驱动表情/动作/气泡）
- `bus:pet-control`：controls → pet（导入/参数控制）
- `bus:pet-control-result`：pet → controls（带 requestId 的结果）
- `bus:pet-state`、`bus:pet-status`：pet → controls（状态与提示）
- `bus:pet-window-state`：main → controls（窗口大小变化）
- `bus:drag-delta`：pet → main（拖拽移动窗口）
- `bus:click-through-changed`：main → pet（穿透状态同步）

### 4.3 降级（BroadcastChannel）

当 preload API 缺失/异常时：

- Controls ⇄ Pet 允许通过 `BroadcastChannel("sama:pet-bus")` 做降级通信（导入 VRM/VRMA、部分参数）
- Caption 同样使用该通道接收 head anchor（以及在 preload 缺失时接收动作广播）

---

## 5. 动作系统（Idle / Walk / VRMA）

优先级：

1) 手动加载的 `.vrma`（ACTION override）
2) Idle/Walk 槽位 `.vrma`（自动切换）
3) 程序 Idle/Walk（兜底）

行为切换：

- 窗口在移动（拖拽 / APPROACH / RETREAT）→ locomotion=WALK
- 窗口静止 → locomotion=IDLE

---

## 6. 传感与行为（Sensing + Core）

Sensing（Windows）：

- `active-win`：前台应用与切换
- `powerMonitor.getSystemIdleTime()`：空闲时间（秒）
- rolling window 统计：2 分钟切换率、3 分钟社交 app 命中

Core（状态机）：

- 计算 `IDLE/FOCUS/FRAGMENTED/SOCIAL_CHECK_LOOP`
- 依据冷却/每日上限/忽略退避输出 ActionCommand（APPROACH/RETREAT/INVITE_CHAT…）

---

## 7. 验收清单（MVP）

- 启动后 pet window 可见（VRM 或占位球体），不会“全透明像卡住”
- 托盘可用；click-through 可切换（托盘/快捷键）
- pet window 可 resize，尺寸会记住
- 可导入 `.vrm`；可导入 `.vrma` 并播放；可设 idle/walk 槽位
- 右键 orbit + Shift+左键 pan 生效
- Chat 窗口能发送；回复以角色旁气泡展示（可见且可读）

