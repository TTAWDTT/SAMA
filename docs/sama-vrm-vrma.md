# SAMA 中的 VRM / VRMA（模型与动作）

本文介绍 SAMA 的 VRM（模型）与 VRMA（动作）体系：加载策略、动作槽位、自动切换、控制接口以及预设动作。

## 基本概念

- **VRM**：角色模型文件（`.vrm`），用于渲染桌面角色。
- **VRMA**：VRM Animation 文件（`.vrma`），用于驱动骨骼动画（例如摆姿势、转圈、下蹲等）。

SAMA 的 3D 渲染与动作播放发生在 **Pet 窗口**（渲染进程）中；主进程与 Controls 通过 IPC 控制 Pet。

## 关键代码位置

- Pet 入口：`apps/stage-desktop/src/renderer/pet/main.ts`
- 场景/相机/动画调度：`apps/stage-desktop/src/renderer/pet/scene.ts`
- VRMA 解析与 clip 生成：`apps/stage-desktop/src/renderer/pet/vrma.ts`
- Controls 动作面板（预设播放/轮播/UI）：`apps/stage-desktop/src/renderer/controls/ui/panels/ActionsPanel.tsx`
- 预设动作定义：`apps/stage-desktop/src/renderer/controls/ui/lib/vrmaPresets.ts`

## VRM 加载与“锁定”

VRM 模型来源由主进程决定（启动时解析）：
- 配置文件：`apps/stage-desktop/config.json`
  - `vrm.locked`：是否锁定模型
  - `vrm.path`：模型路径（相对/绝对）

行为：
- `locked=true`：Pet 侧会忽略 UI/拖拽等切换请求，只使用指定模型。
- 未锁定：可从持久化路径恢复，或使用内置默认模型（`assets/vrm/white_hait.vrm` 等候选路径）。

## VRMA 动作的“槽位”机制

Pet 内部将 VRMA 动画分为三类来源（优先级从高到低）：

1) **Action（手动覆盖）**
- 当用户“加载/播放某个 VRMA”时，通常会作为 Action 立即播放（强制覆盖当前 idle/walk）。

2) **Idle / Walk 槽位（循环）**
- 用户可以将“最近加载的 VRMA（Last Loaded）”提升为槽位：
  - 设为 Idle：待机循环动作
  - 设为 Walk：走路循环动作
- 当没有手动覆盖动作时，系统会根据“当前是否在移动”在 idle/walk 间自动切换。

3) **程序动作（procedural fallback）**
- 如果没有 VRMA 槽位可用，则用程序生成的 idle/walk 维持“活着”的动感（兜底）。

核心决策逻辑在 `apps/stage-desktop/src/renderer/pet/scene.ts` 的 `syncAnimationForMovement(...)`。

## PetControl（IPC 控制接口）

Controls/主进程通过 IPC 向 Pet 发送 `PET_CONTROL` 消息，典型包括：

- `LOAD_VRMA_BYTES`：加载 VRMA 字节并播放（通常进入 Action 覆盖）
- `ASSIGN_VRMA_SLOT_FROM_LAST`：将 lastLoaded 提升为 `idle` 或 `walk` 槽位
- `CLEAR_VRMA_ACTION`：停止手动覆盖动作（回到 idle/walk 自动切换）
- `SET_VRMA_CONFIG`：设置 VRMA 参数（速度、暂停、启用等）

Pet 端接收处理见 `apps/stage-desktop/src/renderer/pet/main.ts` 的 `handlePetControl(...)`。

## 预设动作（内置 VRMA）

SAMA 内置了一组 VRMA 文件作为预设动作（静态资源方式被 Vite 打包）：
- 文件：`apps/stage-desktop/src/renderer/controls/ui/assets/vrma/*.vrma`
- 列表：`apps/stage-desktop/src/renderer/controls/ui/lib/vrmaPresets.ts`

ActionsPanel 支持：
- 点击播放任意预设
- 自动轮播预设动作（默认开启，可在 UI 关闭）

备注：你已要求移除“打招呼”预设动作，因此该动作已从 `VRMA_PRESETS` 中移除，自动轮播也不会再包含它。

## 气泡与动作的协同（与 VRM/VRMA 的关系）

VRM/VRMA 主要负责“身体动画”；气泡系统则负责“表达”：
- Pet 场景会计算气泡锚点（头部附近）
- Caption 窗口根据锚点在角色旁渲染 bubble / thinking
- 当 LLM 回复到来时，主进程会发 `ActionCommand`，Pet 同步表情/说话口型，Caption 展示文字气泡

这样 VRMA 的“姿态/动作”与 Agent 的“语言/情绪反馈”可以同时呈现。

