# SAMA (Electron VRM Desktop Companion, Windows-only MVP)

基于仓库根目录的 `codex_windows_electron_vrm_companion_spec.md` 搭建的 Windows-only 桌面宠物 MVP：

- Electron 透明无边框置顶窗口
- Three.js + `@pixiv/three-vrm` 渲染 `.vrm`
- VRM 动画增强：自动眨眼 / 空闲眼动（saccades）/ 简易“说话”口型 / 支持加载 `.vrma` 动作
- Windows 传感：前台应用、切换频率、空闲时间、夜间标记
- 核心状态机 + 行为策略（APPROACH/RETREAT/INVITE_CHAT）
- 气泡（独立透明窗口覆盖桌宠窗口，跟随角色头部锚点）+ 简易输入窗口
- LLM Provider：OpenAI / DeepSeek / AIStudio（可插拔 + fallback）

## 依赖

- Windows 10/11
- Node.js 20+
- pnpm

## 安装

在本目录执行：

```powershell
pnpm install
```

> 注意：
> - `active-win` / `better-sqlite3` 属于 native 依赖，首次安装可能会下载预编译产物或触发编译。
> - pnpm v10 默认会阻止依赖的安装脚本执行；本仓库已在 `package.json#pnpm.onlyBuiltDependencies` 中放行了必要依赖。

###（可选）网络/代理环境说明

如果你的环境里 `github.com` 被解析到 `127.0.0.1`（或 Electron 下载报 `ECONNREFUSED 127.0.0.1:443`），可以在安装/重建前设置：

```powershell
$env:ELECTRON_GET_USE_PROXY = "1"
```

并确保 `HTTP_PROXY/HTTPS_PROXY` 指向可用代理。

###（重要）如果运行后不弹窗

如果你的环境变量里有 `ELECTRON_RUN_AS_NODE=1`，Electron 会被强制当作 Node 运行，GUI 不会正常启动。

> 说明：`apps/stage-desktop` 的 `pnpm dev/preview` 已经会在启动时自动清理该变量；
> 但如果你是手动运行 `electron-vite dev` / `pnpm exec electron-vite dev`，仍然需要自己清理环境变量。

PowerShell 里可以先执行：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
```

然后再 `pnpm dev`。

###（常见）SQLite 报 NODE_MODULE_VERSION 不匹配

你看到的报错：

> `better_sqlite3.node was compiled against a different Node.js version ...`

原因是：你本机 `pnpm install` 时会为 **Node.js(你装的 Node 版本)** 编译/下载 native 模块；但 Electron 内置的是另一套 Node 版本（ABI 不同），所以运行时加载失败。

解决方式是在 Electron 版本下重建 native 依赖：

```powershell
pnpm --filter @sama/stage-desktop rebuild:native
```

重建完成后重新 `pnpm dev` 即可恢复 SQLite 存储（否则会自动降级到 in-memory，不影响窗口渲染但不持久化）。

## 运行（开发模式）

```powershell
pnpm dev
```

### VRM 模型路径

两种方式任选其一：

- 环境变量：`VRM_PATH=C:\path\model.vrm`
- 启动后在宠物窗口点击 `选择 VRM…`（或控制台点 `加载 VRM…`）弹出文件选择器

应用会把“最近一次选择的 VRM 路径”持久化到 `userData/vrm-path.json`，下次启动会自动加载（无需每次都选）。

> 说明：这里刻意不在启动时强制弹出选择器，避免 always-on-top 窗口遮挡系统对话框导致“看起来卡住”。

也支持 **拖拽导入**：把 `.vrm` 或 `.vrma` 直接拖到桌宠窗口即可加载。

### 窗口移动（拖拽）

- 确保 click-through 处于关闭：托盘菜单切换，或快捷键 `Ctrl+Alt+P`
- 左键拖动：移动桌宠窗口
- Shift + 左键拖动：移动角色在窗口内的位置（平移模型）
- 右键拖动：旋转视角（Orbit）
- 如果拖动不生效：可用右上角的“拖动窗口”小按钮（`-webkit-app-region: drag` 的兜底拖拽区域）
  - 控制台窗口会显示 `穿透：ON/OFF`，ON 时无法拖动（需要先关掉）

### 窗口缩放（Resize）

- 桌宠窗口支持缩放：关闭 click-through 后，直接拖拽窗口边缘/角即可调整大小
- 缩放后角色会自动重新居中并自适应视角；你也可以在控制台里手动微调偏移

### 控制台（独立窗口）

控制台不再固定在宠物窗口里，通过以下方式打开：

- 启动应用后会自动打开（可关闭）
- 托盘菜单：`Open Controls`
- 快捷键：`Ctrl+Alt+O`

控制台优先使用“快捷操作”：

- `加载 VRM…`：选择模型（也可拖拽 `.vrm` 到窗口）
- `加载 VRMA…`：选择动作（也可拖拽 `.vrma` 到窗口）
- `设为 Idle / 设为 Walk`：把“最近加载的 VRMA”放入自动切换槽位
- `停止动作`：取消手动动作覆盖，回到自动 Idle/Walk
- `测试：走两步`：不移动窗口也能验证 Idle/Walk 切换是否生效

动作库（自定义名字）：

- 在控制台的 `动作库（自定义名字）` 里输入名字并点 `保存`，即可把“最近加载的 VRMA”存进库里
- 之后可以在列表里按名字 `播放 / 设为 Idle / 设为 Walk / 重命名 / 删除`

折叠区（高级）提供更精确的参数：

- 模型：缩放 / Yaw 旋转 / XYZ 偏移 / 重新居中（重置视角）
- 待机：启用/禁用、呼吸/摆动强度、手臂自然下垂、手肘微弯、速度
- 行走（程序动画）：启用/禁用、速度、步幅、摆臂、上下起伏、前倾（用于窗口移动/拖拽时）
- 动作（VRMA）：启用/暂停、速度、停止动作（回到待机）

### Idle / Walk / 动作切换（Airi-like）

- 当宠物窗口在移动（拖拽 / APPROACH / RETREAT）时，会自动进入 **WALK**（走路）
- 当窗口静止时，会自动进入 **IDLE**（待机）
- 优先级：手动加载的 `.vrma` 动作（ACTION） > Walk/Idle 槽位 > 程序动画

内置 Idle（兜底）：

- 如果没有给 Idle 槽位指定 `.vrma`，且 VRM 内也没有可用的嵌入动画，会自动加载一个内置的“idle-like” VRMA（用于开箱即用）
- 你仍然可以随时加载自己的 `.vrma` 并设为 Idle 来覆盖它

如果你有 Airi/其他来源的 `.vrma`：

1. 先加载一个 `.vrma`（会当作动作播放）
2. 在控制台里点击 `设为 Idle` 或 `设为 Walk` 放入自动切换槽位
3. 点击 `停止动作` 可从 ACTION 回到自动 Idle/Walk

### 社交应用列表配置

编辑：`apps/stage-desktop/config.json`

```json
{
  "socialApps": ["WeChat.exe", "QQ.exe", "Telegram.exe", "Discord.exe"]
}
```

### LLM 配置

使用环境变量选择 provider：

- `LLM_PROVIDER=openai|deepseek|aistudio`
- `OPENAI_API_KEY=...`
- `DEEPSEEK_API_KEY=...`
- `AISTUDIO_API_KEY=...`

可选：指定模型（默认有内置值）

- `OPENAI_MODEL=...`
- `OPENAI_BASE_URL=...`（可选，OpenAI-compatible 网关时用）
- `DEEPSEEK_MODEL=...`
- `AISTUDIO_MODEL=...`
- `DEEPSEEK_BASE_URL=...`

`aistudio` 默认按 Google AI Studio / Gemini 的 `generateContent` 接口调用；如果你有 OpenAI-compatible 网关，也可以额外设置：

- `AISTUDIO_BASE_URL=...`（启用 OpenAI-compatible 模式）

也可以直接在 `apps/stage-desktop/config.json` 里配置（更适合不想折腾 env 的情况）：

- `apps/stage-desktop/config.json` 中的 `llm.provider`：`auto|off|openai|deepseek|aistudio`
- `apps/stage-desktop/config.json` 中的 `llm.openai/apiKey/model/baseUrl` 等字段

更推荐把密钥放到 `apps/stage-desktop/config.local.json`（会覆盖 `config.json`，且已加入 `.gitignore`，不会被提交）。

> 注意：`config.json` / `config.local.json` 里放 API Key 属于明文存储，适合本地个人使用；如仓库要公开/多人共享，请使用环境变量并避免提交密钥。

## 手动验收清单（MVP）

1. 启动后桌面显示 VRM 角色
2. 头/眼跟随鼠标（LookAt）
3. 可拖拽移动宠物窗口（click-through OFF 时）
4. 托盘菜单可切换 click-through
5. 控制台输出 sensing/state 日志
6. 快速切换应用触发 APPROACH + bubble
7. 点击宠物触发短暂 HAPPY
8. Chat 输入窗口可发送消息，SAMA 会以气泡回复（LLM 或 fallback）

> 说明：Chat 窗口现在是“输入为主”的窗口；SAMA 的回复会以气泡显示在角色旁（不会在 Chat 窗口里刷出一条 bot 消息）。
