import { app, dialog, ipcMain, screen } from "electron";
import type { BrowserWindow } from "electron";
import { BrowserWindow as ElectronBrowserWindow } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { IPC_CHANNELS, IPC_HANDLES } from "@sama/shared";
import { ChatRequestSchema, ManualActionSchema, UserInteractionSchema } from "@sama/shared";
import type {
  ActionCommand,
  AppLogMessage,
  ChatLogEntry,
  ChatLogMessage,
  ChatRequest,
  ManualActionMessage,
  PetControlMessage,
  PetControlResult,
  PetDisplayModeConfig,
  PetStateMessage,
  PetStatusMessage,
  PetWindowSize,
  PetWindowStateMessage,
  UserInteraction
} from "@sama/shared";
import type { AppConfig, DragDelta, LLMConfig } from "./protocol/types";
import { createCaptionWindow } from "./windows/caption.window";
import { createChatWindow } from "./windows/chat.window";
import { createControlsWindow } from "./windows/controls.window";
import { PET_WINDOW_DEFAULT_SIZE, PET_WINDOW_MIN_SIZE, createPetWindow } from "./windows/pet.window";
import { CoreService } from "./services/core.service";
import { LLMService } from "./services/llm.service";
import { MemoryService } from "./services/memory.service";
import { SensingService } from "./services/sensing.service";
import { ShortcutsService } from "./services/shortcuts.service";
import { TrayService } from "./services/tray.service";
import { SkillService } from "./services/skill.service";

function easeInOutQuad(t: number) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function resolvePreloadPath() {
  const tried: string[] = [];
  const candidates: string[] = [
    join(__dirname, "../preload/preload.js"),
    join(__dirname, "../preload/preload.cjs"),
    join(__dirname, "../preload/preload.mjs"),
    join(process.cwd(), "out/preload/preload.js"),
    join(process.cwd(), "dist/preload/preload.js")
  ];

  // `app.getAppPath()` is stable after `app.whenReady()`.
  try {
    const appPath = app.getAppPath();
    candidates.push(join(appPath, "out/preload/preload.js"));
    candidates.push(join(appPath, "dist/preload/preload.js"));
  } catch {}

  for (const p of candidates) {
    tried.push(p);
    if (existsSync(p)) return { path: p, tried };
  }

  return { path: candidates[0], tried };
}

function readAppConfig(configPath: string): AppConfig {
  const defaults: AppConfig = {
    socialApps: ["WeChat.exe", "QQ.exe", "Telegram.exe", "Discord.exe"],
    captionOffset: { x: 20, y: -120 }
  };

  const base: any = (() => {
    try {
      const raw = readFileSync(configPath, "utf-8");
      return JSON.parse(raw);
    } catch {
      return {};
    }
  })();

  const localPath = resolve(dirname(configPath), "config.local.json");
  const local: any = (() => {
    try {
      if (!existsSync(localPath)) return {};
      const raw = readFileSync(localPath, "utf-8");
      return JSON.parse(raw);
    } catch {
      return {};
    }
  })();

  const socialApps = Array.isArray(local.socialApps)
    ? local.socialApps
    : Array.isArray(base.socialApps)
      ? base.socialApps
      : defaults.socialApps;

  const captionOffset = {
    x: Number(local?.captionOffset?.x ?? base?.captionOffset?.x ?? defaults.captionOffset?.x ?? 20),
    y: Number(local?.captionOffset?.y ?? base?.captionOffset?.y ?? defaults.captionOffset?.y ?? -120)
  };

  const llm = (() => {
    const baseLlm: any = base?.llm ?? null;
    const localLlm: any = local?.llm ?? null;
    if (!baseLlm && !localLlm) return undefined;
    return {
      provider: localLlm?.provider ?? baseLlm?.provider,
      openai: { ...(baseLlm?.openai ?? {}), ...(localLlm?.openai ?? {}) },
      deepseek: { ...(baseLlm?.deepseek ?? {}), ...(localLlm?.deepseek ?? {}) },
      aistudio: { ...(baseLlm?.aistudio ?? {}), ...(localLlm?.aistudio ?? {}) }
    };
  })();

  const vrm = (() => {
    const baseVrm: any = base?.vrm ?? null;
    const localVrm: any = local?.vrm ?? null;
    if (!baseVrm && !localVrm) return undefined;
    const lockedRaw = localVrm?.locked ?? baseVrm?.locked;
    const locked = lockedRaw === undefined ? undefined : Boolean(lockedRaw);
    const path = String(localVrm?.path ?? baseVrm?.path ?? "").trim();
    return { locked, path };
  })();

  return { socialApps, captionOffset, llm, vrm };
}

function readPersistedPetWindowSize(statePath: string): PetWindowSize | null {
  try {
    const raw = readFileSync(statePath, "utf-8");
    const parsed: any = JSON.parse(raw);
    const w = Math.round(Number(parsed?.width ?? 0));
    const h = Math.round(Number(parsed?.height ?? 0));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    return { width: w, height: h };
  } catch {
    return null;
  }
}

function writePersistedPetWindowSize(statePath: string, size: PetWindowSize) {
  try {
    writeFileSync(statePath, JSON.stringify({ width: size.width, height: size.height }, null, 2), "utf-8");
  } catch (err) {
    console.warn("[pet-window] failed to persist size:", err);
  }
}

function readPersistedVrmPath(statePath: string): string | null {
  try {
    const raw = readFileSync(statePath, "utf-8");
    const parsed: any = JSON.parse(raw);
    const p = String(parsed?.path ?? "").trim();
    if (!p) return null;
    if (!existsSync(p)) return null;
    return p;
  } catch {
    return null;
  }
}

function writePersistedVrmPath(statePath: string, vrmPath: string | null) {
  try {
    writeFileSync(statePath, JSON.stringify({ path: vrmPath ?? "" }, null, 2), "utf-8");
  } catch (err) {
    console.warn("[vrm] failed to persist vrm path:", err);
  }
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function sanitizeLlmConfig(raw: unknown): LLMConfig {
  const cfg: LLMConfig = {};
  if (!isPlainObject(raw)) return cfg;

  const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
  if (provider) cfg.provider = provider as any;

  const pickProviderBlock = (key: "openai" | "deepseek" | "aistudio") => {
    const b = (raw as any)[key];
    if (!isPlainObject(b)) return undefined;
    const out: any = {};
    // apiKey: allow empty string so users can explicitly clear it.
    if (typeof b.apiKey === "string") out.apiKey = b.apiKey;

    // baseUrl/model: ignore empty strings so "clear" reverts to defaults from config.json.
    if (typeof b.model === "string") {
      const s = b.model.trim();
      if (s) out.model = s;
    }
    if (typeof b.baseUrl === "string") {
      const s = b.baseUrl.trim();
      if (s) out.baseUrl = s;
    }
    return out;
  };

  const openai = pickProviderBlock("openai");
  if (openai) cfg.openai = openai;
  const deepseek = pickProviderBlock("deepseek");
  if (deepseek) cfg.deepseek = deepseek;
  const aistudio = pickProviderBlock("aistudio");
  if (aistudio) cfg.aistudio = aistudio;

  // Web search config (Tavily)
  if (isPlainObject((raw as any).webSearch)) {
    const b: any = (raw as any).webSearch;
    const out: any = {};
    if (typeof b.enabled === "boolean") out.enabled = b.enabled;
    // allow empty string so users can explicitly clear it.
    if (typeof b.tavilyApiKey === "string") out.tavilyApiKey = b.tavilyApiKey;
    if (b.maxResults !== undefined) {
      const n = Math.floor(Number(b.maxResults) || 0);
      if (Number.isFinite(n) && n > 0) out.maxResults = Math.max(1, Math.min(10, n));
    }
    cfg.webSearch = out;
  }

  // Skills config (~/.claude/skills)
  if (isPlainObject((raw as any).skills)) {
    const b: any = (raw as any).skills;
    const out: any = {};
    if (typeof b.dir === "string") {
      const s = b.dir.trim();
      if (s) out.dir = s;
    }
    if (Array.isArray(b.enabled)) {
      out.enabled = b.enabled.map((x: any) => String(x ?? "").trim()).filter((x: string) => x);
    }
    cfg.skills = out;
  }
  return cfg;
}

function mergeLlmConfig(base: LLMConfig | null | undefined, override: LLMConfig | null | undefined): LLMConfig | null {
  if (!base && !override) return null;
  return {
    provider: (override?.provider ?? base?.provider) as any,
    openai: { ...(base?.openai ?? {}), ...(override?.openai ?? {}) },
    deepseek: { ...(base?.deepseek ?? {}), ...(override?.deepseek ?? {}) },
    aistudio: { ...(base?.aistudio ?? {}), ...(override?.aistudio ?? {}) },
    webSearch: { ...(base?.webSearch ?? {}), ...(override?.webSearch ?? {}) },
    skills: { ...(base?.skills ?? {}), ...(override?.skills ?? {}) }
  };
}

function readPersistedLlmConfig(statePath: string): LLMConfig | null {
  try {
    if (!existsSync(statePath)) return null;
    const raw = readFileSync(statePath, "utf-8");
    const parsed: any = JSON.parse(raw);
    const cfgRaw =
      isPlainObject(parsed) && isPlainObject(parsed.config)
        ? parsed.config
        : isPlainObject(parsed) && isPlainObject(parsed.llm)
          ? parsed.llm
          : isPlainObject(parsed)
            ? parsed
            : null;
    if (!cfgRaw) return null;
    return sanitizeLlmConfig(cfgRaw);
  } catch {
    return null;
  }
}

function writePersistedLlmConfig(statePath: string, cfg: LLMConfig) {
  try {
    writeFileSync(statePath, JSON.stringify({ version: 1, config: cfg }, null, 2), "utf-8");
  } catch (err) {
    console.warn("[llm] failed to persist llm config:", err);
  }
}

async function pickVrmPathForced(parent: BrowserWindow | null, current: string | null) {
  const opts: Electron.OpenDialogOptions = {
    title: "Select a .vrm model",
    properties: ["openFile"],
    filters: [{ name: "VRM", extensions: ["vrm"] }],
    defaultPath: current ?? undefined
  };
  const res =
    parent && !parent.isDestroyed() ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
}

function computeDefaultHome(petSize: { w: number; h: number }) {
  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  const margin = 20;
  return {
    x: wa.x + wa.width - petSize.w - margin,
    y: wa.y + wa.height - petSize.h - margin
  };
}

type Point = { x: number; y: number };

function animateMove(
  getCurrent: () => Point,
  setPos: (p: Point) => void,
  target: Point,
  durationMs: number,
  cancelSignal: { canceled: boolean }
) {
  const start = getCurrent();
  const startTs = Date.now();

  const tick = () => {
    if (cancelSignal.canceled) return;
    const t = Math.min(1, (Date.now() - startTs) / Math.max(1, durationMs));
    const k = easeInOutQuad(t);
    const x = Math.round(start.x + (target.x - start.x) * k);
    const y = Math.round(start.y + (target.y - start.y) * k);
    setPos({ x, y });
    if (t < 1) setTimeout(tick, 16);
  };

  tick();
}

let vrmPath: string | null = process.env.VRM_PATH ?? null;
let vrmLocked = false;

async function bootstrap() {
  await app.whenReady();
  app.setAppUserModelId("SAMA.VRMCompanion");

  const configPath = resolve(process.cwd(), "config.json");
  const config = readAppConfig(configPath);
  const baseLlmConfig = config.llm ?? null;
  const llmConfigStatePath = join(app.getPath("userData"), "llm-config.json");
  let persistedLlmConfig = readPersistedLlmConfig(llmConfigStatePath);
  const llm = new LLMService({ config: mergeLlmConfig(baseLlmConfig, persistedLlmConfig) });
  console.log(`[llm] provider=${llm.providerName}`);

  let core: CoreService | null = null;

  // electron-vite outputs preload bundle as `out/preload/preload.js` in this template,
  // but we keep this resolver defensive to avoid "preload API missing" in case of outDir mismatch.
  const preloadResolved = resolvePreloadPath();
  const preloadPath = preloadResolved.path;
  if (!existsSync(preloadPath)) {
    console.warn("[main] preload script not found:", preloadPath);
    console.warn("[main] tried:\n" + preloadResolved.tried.join("\n"));
    dialog.showErrorBox(
      "SAMA preload not found",
      `preload 脚本不存在，Controls 将无法使用。\n\nExpected:\n${preloadPath}\n\nTried:\n${preloadResolved.tried.join(
        "\n"
      )}`
    );
  }
  const petWindowStatePath = join(app.getPath("userData"), "pet-window-state.json");
  const vrmPathStatePath = join(app.getPath("userData"), "vrm-path.json");

  // Optional: lock VRM to a single configured model (no runtime switching via UI/drag).
  const cfgVrmLocked = Boolean(config.vrm?.locked);
  const cfgVrmPathRaw = String(config.vrm?.path ?? "").trim();
  const cfgVrmPath = cfgVrmPathRaw ? resolve(dirname(configPath), cfgVrmPathRaw) : null;

  if (cfgVrmLocked) {
    vrmLocked = true;
    if (cfgVrmPath && existsSync(cfgVrmPath)) {
      vrmPath = cfgVrmPath;
      console.log(`[vrm] locked: ${vrmPath}`);
    } else {
      vrmPath = null;
      console.warn("[vrm] locked, but vrm.path missing or not found:", cfgVrmPathRaw);
      try {
        dialog.showErrorBox(
          "SAMA VRM locked but missing",
          `你启用了 VRM 锁定（config.local.json / config.json），但找不到模型文件。\n\nvrm.path=${cfgVrmPathRaw || "(empty)"}\nresolved=${
            cfgVrmPath ?? "(null)"
          }\n\n请把 vrm.path 指向一个存在的 .vrm 文件。`
        );
      } catch {}
    }
  } else {
    if (!vrmPath) {
      const persisted = readPersistedVrmPath(vrmPathStatePath);
      if (persisted) vrmPath = persisted;
    }
    if (vrmPath && !existsSync(vrmPath)) {
      console.warn("[vrm] VRM_PATH not found, will require manual pick:", vrmPath);
      vrmPath = null;
    }
    // If still no VRM path, try to load bundled default VRM
    if (!vrmPath) {
      const bundledVrmPaths = [
        // Development: relative to project root (monorepo root)
        resolve(process.cwd(), "assets/vrm/white_hait.vrm"),
        // Development: relative to monorepo root from apps/stage-desktop
        resolve(process.cwd(), "..", "..", "assets/vrm/white_hait.vrm"),
        // Production: in resources/app/assets
        join(app.getAppPath(), "assets/vrm/white_hait.vrm"),
        // Electron-builder extraResources scenario
        join(process.resourcesPath || "", "assets/vrm/white_hait.vrm"),
        // Electron-vite dev mode - from src/main up to stage-desktop then to SAMA root
        resolve(dirname(import.meta.dirname || __dirname), "..", "assets/vrm/white_hait.vrm"),
        resolve(dirname(import.meta.dirname || __dirname), "..", "..", "assets/vrm/white_hait.vrm"),
        resolve(dirname(import.meta.dirname || __dirname), "..", "..", "..", "assets/vrm/white_hait.vrm"),
        resolve(dirname(import.meta.dirname || __dirname), "..", "..", "..", "..", "assets/vrm/white_hait.vrm")
      ];
      for (const p of bundledVrmPaths) {
        if (existsSync(p)) {
          vrmPath = p;
          console.log("[vrm] using bundled default:", vrmPath);
          break;
        }
      }
    }
  }

  const persistedPetSize = readPersistedPetWindowSize(petWindowStatePath);
  const initialPetSize: PetWindowSize = {
    width: Math.max(PET_WINDOW_MIN_SIZE.width, persistedPetSize?.width ?? PET_WINDOW_DEFAULT_SIZE.width),
    height: Math.max(PET_WINDOW_MIN_SIZE.height, persistedPetSize?.height ?? PET_WINDOW_DEFAULT_SIZE.height)
  };

  // `ipcRenderer.invoke(IPC_HANDLES.vrmGet)` is called very early by the pet renderer.
  // Register this handler BEFORE any slow init work (SQLite, LLM, etc.) to avoid a race:
  // "No handler registered for 'vrmGet'" which would make the window stay fully transparent.
  let petWindowRef: BrowserWindow | null = null;
  let cachedVrm: { path: string; bytes: Uint8Array } | null = null;

  ipcMain.handle(IPC_HANDLES.appInfoGet, async () => ({ vrmLocked, llmProvider: llm.providerName }));

  ipcMain.handle(IPC_HANDLES.llmConfigGet, async () => {
    const effective = mergeLlmConfig(baseLlmConfig, persistedLlmConfig);
    const skillsDir = String(effective?.skills?.dir ?? "").trim() || undefined;
    const skillSvc = new SkillService({ skillsDir });
    return {
      storagePath: llmConfigStatePath,
      stored: persistedLlmConfig,
      effective,
      provider: llm.providerName,
      skillsDir: skillSvc.skillsDir,
      availableSkills: skillSvc.listSkills().map((s) => s.name)
    };
  });

  ipcMain.handle(IPC_HANDLES.llmConfigSet, async (_evt, payload: any) => {
    try {
      const rawCfg = isPlainObject(payload) && isPlainObject(payload.config) ? payload.config : payload;
      const cfg = sanitizeLlmConfig(rawCfg);
      writePersistedLlmConfig(llmConfigStatePath, cfg);
      persistedLlmConfig = cfg;
      const nextEffective = mergeLlmConfig(baseLlmConfig, persistedLlmConfig);
      llm.setConfig(nextEffective);
      core?.setAssistantConfig(nextEffective);
      return { ok: true, provider: llm.providerName };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: msg };
    }
  });

  ipcMain.handle(IPC_HANDLES.chatLogGet, async () => {
    const msg: ChatLogMessage = { type: "CHAT_LOG_SYNC", ts: Date.now(), entries: chatLog };
    return msg;
  });

  ipcMain.handle(IPC_HANDLES.vrmGet, async (_evt) => {
    // IMPORTANT:
    // Do NOT trigger a blocking file picker here.
    // Some users reported startup "hangs" because the first-render awaits this handler and the dialog may be hidden
    // behind an always-on-top window. Instead, return empty bytes when no path is configured.
    if (!vrmPath || !existsSync(vrmPath)) return new Uint8Array();
    if (cachedVrm?.path === vrmPath) return cachedVrm.bytes;
    const buf = readFileSync(vrmPath);
    const bytes = new Uint8Array(buf);
    cachedVrm = { path: vrmPath, bytes };
    return bytes;
  });

  ipcMain.handle(IPC_HANDLES.vrmPick, async (evt) => {
    if (vrmLocked) {
      if (!vrmPath || !existsSync(vrmPath)) return new Uint8Array();
      if (cachedVrm?.path === vrmPath) return cachedVrm.bytes;
      const buf = readFileSync(vrmPath);
      const bytes = new Uint8Array(buf);
      cachedVrm = { path: vrmPath, bytes };
      return bytes;
    }

    const parent = ElectronBrowserWindow.fromWebContents(evt.sender) ?? petWindowRef;
    const picked = await pickVrmPathForced(parent, vrmPath);
    if (!picked) return new Uint8Array();
    vrmPath = picked;
    writePersistedVrmPath(vrmPathStatePath, vrmPath);
    const buf = readFileSync(vrmPath);
    const bytes = new Uint8Array(buf);
    cachedVrm = { path: vrmPath, bytes };
    return bytes;
  });

  const petWindow = createPetWindow({ preloadPath, initialSize: initialPetSize });
  petWindowRef = petWindow;
  const captionWindow = createCaptionWindow({ preloadPath, width: initialPetSize.width, height: initialPetSize.height });

  const wirePreloadDiagnostics = (win: BrowserWindow, label: string) => {
    win.webContents.on("preload-error", (_evt, p, error) => {
      console.error(`[preload-error][${label}] ${p}:`, error);
      try {
        dialog.showErrorBox(
          `SAMA preload error (${label})`,
          `preload 脚本执行失败，Controls / IPC 将不可用。\n\npreload: ${p}\nerror: ${error.message}`
        );
      } catch {}
    });
  };

  wirePreloadDiagnostics(petWindow, "pet");
  wirePreloadDiagnostics(captionWindow, "caption");

  const initialBounds = petWindow.getBounds();
  const home = computeDefaultHome({ w: initialBounds.width, h: initialBounds.height });
  petWindow.setPosition(home.x, home.y);
  captionWindow.setBounds(petWindow.getBounds());
  // "homePosition" is the position RETREAT returns to. We keep separate homes per display mode
  // so switching modes doesn't lose the user's placement.
  let homePosition: Point = { ...home };
  let normalHomePosition: Point = { ...home };
  let peekHomePosition: Point = { ...home };

  // Display mode state (normal vs peek)
  // Note: "peek" is intended to be a "只露出脑袋" mode (dock to bottom edge).
  let displayModeConfig: PetDisplayModeConfig = { mode: "normal", edge: "bottom", tiltDeg: 15 };
  let lastDisplayMode: PetDisplayModeConfig["mode"] = displayModeConfig.mode;

  const applyDisplayMode = () => {
    if (petWindow.isDestroyed()) return;

    const [winW, winH] = petWindow.getSize();
    const bNow = petWindow.getBounds();
    const display = screen.getDisplayMatching(bNow);
    const wa = display.workArea;
    const margin = 10;

    const clampX = (x: number) => clamp(x, wa.x + margin, wa.x + wa.width - winW - margin);
    const clampY = (y: number) => clamp(y, wa.y + margin, wa.y + wa.height - winH - margin);

    // When entering peek mode, initialize the peek baseline from the current window position
    // so the user keeps their vertical/horizontal placement.
    if (displayModeConfig.mode !== lastDisplayMode) {
      if (displayModeConfig.mode === "peek") {
        const [cx, cy] = petWindow.getPosition();
        peekHomePosition = { x: cx, y: cy };
      }
      lastDisplayMode = displayModeConfig.mode;
    }

    if (displayModeConfig.mode === "peek") {
      // "探出小脑袋" mode: hug the bottom edge and only keep a small portion visible.
      // We intentionally keep this as a simple, predictable behavior (no left/right peek),
      // because the UX expectation is "stick to desktop bottom and show only head".
      // Keep the visible area small so only the head is shown.
      // Note: this is intentionally conservative because different VRMs/camera scales vary a lot.
      // We'll later expose this as a user-tunable setting if needed.
      const visibleH = clamp(Math.round(winH * 0.18), 80, 140);

      const x = clampX(peekHomePosition.x);
      const y = wa.y + wa.height - visibleH;

      petWindow.setPosition(Math.round(x), Math.round(y));
      const [nx, ny] = petWindow.getPosition();
      peekHomePosition = { x: nx, y: ny };
      homePosition = { x: nx, y: ny };

      // Peek-from-bottom doesn't need yaw. (If we add pitch/roll later, we can use it here.)
      petWindow.webContents.send(IPC_CHANNELS.petControl, {
        type: "PET_CONTROL",
        ts: Date.now(),
        action: "SET_MODEL_TRANSFORM",
        transform: { yawDeg: 0 }
      });
    } else {
      // Normal mode - restore last normal position and reset rotation.
      const x = clampX(normalHomePosition.x);
      const y = clampY(normalHomePosition.y);
      petWindow.setPosition(Math.round(x), Math.round(y));
      const [nx, ny] = petWindow.getPosition();
      normalHomePosition = { x: nx, y: ny };
      homePosition = { ...normalHomePosition };

      petWindow.webContents.send(IPC_CHANNELS.petControl, {
        type: "PET_CONTROL",
        ts: Date.now(),
        action: "SET_MODEL_TRANSFORM",
        transform: { yawDeg: 0 }
      });
    }

    emitPetWindowState();
  };

  let clickThroughEnabled = false;
  let chatWindow: import("electron").BrowserWindow | null = null;
  let controlsWindow: import("electron").BrowserWindow | null = null;
  let lastPetState: PetStateMessage | null = null;
  let lastPetWindowState: PetWindowStateMessage | null = null;
  let chatLog: ChatLogEntry[] = [];
  let appLogs: AppLogMessage[] = [];
  // Caption window now overlays the pet window (same bounds) so the bubble can be anchored to the character.

  const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

  const placeQuickSendNearCursor = (win: BrowserWindow) => {
    try {
      const cursor = screen.getCursorScreenPoint();
      const display = screen.getDisplayNearestPoint(cursor);
      const wa = display.workArea;
      const [w, h] = win.getSize();
      const margin = 12;

      // Prefer above the cursor so it feels like a "palette"; clamp to workArea.
      const x = Math.round(clamp(cursor.x - w / 2, wa.x + margin, wa.x + wa.width - w - margin));
      const y = Math.round(clamp(cursor.y - h - 18, wa.y + margin, wa.y + wa.height - h - margin));
      win.setPosition(x, y);
    } catch {}
  };

  const openChat = () => {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.show();
      chatWindow.focus();
      try {
        chatWindow.moveTop();
      } catch {}
      placeQuickSendNearCursor(chatWindow);
      return;
    }
    chatWindow = createChatWindow({ preloadPath });
    chatWindow.once("ready-to-show", () => placeQuickSendNearCursor(chatWindow!));
    chatWindow.on("closed", () => {
      chatWindow = null;
    });
  };

  const openControls = () => {
    if (controlsWindow && !controlsWindow.isDestroyed()) {
      controlsWindow.show();
      controlsWindow.focus();
      return;
    }
    controlsWindow = createControlsWindow({ preloadPath });
    wirePreloadDiagnostics(controlsWindow, "controls");
    controlsWindow.webContents.once("did-finish-load", () => {
      if (lastPetState) controlsWindow?.webContents.send(IPC_CHANNELS.petState, lastPetState);
      if (lastPetWindowState) controlsWindow?.webContents.send(IPC_CHANNELS.petWindowState, lastPetWindowState);
      // Sync chat history for the main chat UI.
      const msg: ChatLogMessage = { type: "CHAT_LOG_SYNC", ts: Date.now(), entries: chatLog };
      controlsWindow?.webContents.send(IPC_CHANNELS.chatLog, msg);

      // Sync recent app logs (for the in-app dev console).
      try {
        for (const l of appLogs.slice(-240)) {
          controlsWindow?.webContents.send(IPC_CHANNELS.appLog, l);
        }
      } catch {}
    });
    controlsWindow.on("closed", () => {
      controlsWindow = null;
    });
  };

  const setClickThrough = (enabled: boolean) => {
    clickThroughEnabled = enabled;
    petWindow.setIgnoreMouseEvents(enabled, { forward: true });
    petWindow.webContents.send(IPC_CHANNELS.clickThroughChanged, enabled);
  };

  const toggleClickThrough = () => setClickThrough(!clickThroughEnabled);

  const togglePetVisible = () => {
    const visible = petWindow.isVisible();
    if (visible) {
      petWindow.hide();
      captionWindow.hide();
    } else {
      petWindow.showInactive();
      captionWindow.showInactive();
    }
  };

  const memory = new MemoryService({ dbPath: join(app.getPath("userData"), "memory.db") });
  await memory.init();

  // Restore chat history across restarts (long-term memory foundation).
  try {
    chatLog = memory.getRecentChatLogEntries(260);
  } catch {}

  let moveCancel = { canceled: false };
  const moveTo = (p: Point, durationMs: number) => {
    moveCancel.canceled = true;
    moveCancel = { canceled: false };
    animateMove(
      () => {
        const [x, y] = petWindow.getPosition();
        return { x, y };
      },
      (pos) => petWindow.setPosition(pos.x, pos.y),
      p,
      durationMs,
      moveCancel
    );
  };

  const computeApproachTarget = (): Point => {
    const display = screen.getPrimaryDisplay();
    const wa = display.workArea;
    const center = { x: wa.x + wa.width / 2, y: wa.y + wa.height / 2 };
    const dirX = center.x - homePosition.x;
    const dirY = center.y - homePosition.y;
    const len = Math.max(1, Math.hypot(dirX, dirY));
    return {
      x: Math.round(homePosition.x + (dirX / len) * 120),
      y: Math.round(homePosition.y + (dirY / len) * 120)
    };
  };

  let pendingIgnoreTimer: NodeJS.Timeout | null = null;
  let pendingIgnore: { action: "APPROACH" | "INVITE_CHAT"; cmdTs: number } | null = null;

  function disarmPendingIgnore() {
    if (pendingIgnoreTimer) clearTimeout(pendingIgnoreTimer);
    pendingIgnoreTimer = null;
    pendingIgnore = null;
  }

  function armPendingIgnore(action: "APPROACH" | "INVITE_CHAT", cmdTs: number, durationMs: number) {
    pendingIgnore = { action, cmdTs };
    pendingIgnoreTimer = setTimeout(() => {
      const p = pendingIgnore;
      if (!p || p.cmdTs !== cmdTs) return;
      disarmPendingIgnore();
      core.handleUserInteraction({
        type: "USER_INTERACTION",
        ts: Date.now(),
        event: "IGNORED_ACTION",
        action
      });
    }, Math.max(200, durationMs));
  }

  const formatLogArg = (a: unknown) => {
    if (typeof a === "string") return a;
    if (typeof a === "number" || typeof a === "boolean" || a === null || a === undefined) return String(a);
    try {
      return JSON.stringify(a);
    } catch {
      return Object.prototype.toString.call(a);
    }
  };

  const pushAppLog = (level: AppLogMessage["level"], args: unknown[], scope?: string) => {
    const msg: AppLogMessage = {
      type: "APP_LOG",
      ts: Date.now(),
      level,
      message: args.map(formatLogArg).join(" "),
      ...(scope ? { scope } : {})
    };
    appLogs.push(msg);
    if (appLogs.length > 900) appLogs = appLogs.slice(-720);
    if (controlsWindow && !controlsWindow.isDestroyed()) {
      try {
        controlsWindow.webContents.send(IPC_CHANNELS.appLog, msg);
      } catch {}
    }
  };

  // Forward main-process logs to the Controls window so we can have an in-app dev console.
  // Keep behavior identical: we still print to stdout/stderr, we just also mirror to IPC.
  const origConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };
  console.log = (...args: any[]) => {
    origConsole.log(...args);
    pushAppLog("info", args);
  };
  console.warn = (...args: any[]) => {
    origConsole.warn(...args);
    pushAppLog("warn", args);
  };
  console.error = (...args: any[]) => {
    origConsole.error(...args);
    pushAppLog("error", args);
  };

  core = new CoreService({
    llm,
    memory,
    onAction: (cmd, meta) => {
      petWindow.webContents.send(IPC_CHANNELS.actionCommand, cmd);
      captionWindow.webContents.send(IPC_CHANNELS.actionCommand, cmd);

      // Ensure caption bubble stays visible above the pet window on Windows.
      // Some z-order edge cases can put two always-on-top windows in an unexpected stacking order.
      if (cmd.bubble || cmd.bubbleKind === "thinking") {
        try {
          if (!captionWindow.isDestroyed()) {
            captionWindow.showInactive();
            captionWindow.moveTop();
          }
        } catch {}
      }

      if (meta.proactive) {
        console.log(`[core] action=${cmd.action} expr=${cmd.expression} bubble=${cmd.bubble ?? ""}`);
      }

      // Ignore detection: if a proactive APPROACH/INVITE_CHAT gets no response within duration,
      // emit IGNORED_ACTION back into the core.
      if (meta.proactive && (cmd.action === "APPROACH" || cmd.action === "INVITE_CHAT")) {
        disarmPendingIgnore();
        armPendingIgnore(cmd.action, cmd.ts, cmd.durationMs || 3000);
      } else if (cmd.action === "RETREAT") {
        disarmPendingIgnore();
      }

      if (cmd.action === "APPROACH") moveTo(computeApproachTarget(), cmd.durationMs || 1500);
      if (cmd.action === "RETREAT") moveTo(homePosition, cmd.durationMs || 1500);
    }
  });
  core.setAssistantConfig(mergeLlmConfig(baseLlmConfig, persistedLlmConfig));

  const sensing = new SensingService({
    configPath,
    onUpdate: (u) => void core.handleSensorUpdate(u)
  });
  sensing.start();

  const tray = new TrayService({
    toggleClickThrough,
    isClickThroughEnabled: () => clickThroughEnabled,
    togglePetVisible,
    isPetVisible: () => petWindow.isVisible(),
    openControls,
    openChat,
    quit: () => app.quit()
  });
  tray.start();

  const shortcuts = new ShortcutsService({ toggleClickThrough, openChat, openControls });
  shortcuts.start();

  const followTimer = setInterval(() => {
    if (petWindow.isDestroyed() || captionWindow.isDestroyed()) return;
    if (!petWindow.isVisible()) return;
    const b = petWindow.getBounds();
    captionWindow.setBounds(b);
  }, 50);

  const persistPetWindowSize = () => {
    if (petWindow.isDestroyed()) return;
    const b = petWindow.getBounds();
    writePersistedPetWindowSize(petWindowStatePath, { width: b.width, height: b.height });
  };

  let pendingPersistTimer: NodeJS.Timeout | null = null;
  const schedulePersistPetWindowSize = () => {
    if (pendingPersistTimer) clearTimeout(pendingPersistTimer);
    pendingPersistTimer = setTimeout(() => {
      pendingPersistTimer = null;
      persistPetWindowSize();
    }, 350);
  };

  const emitPetWindowState = () => {
    if (petWindow.isDestroyed()) return;
    const b = petWindow.getBounds();
    const display = screen.getDisplayMatching(b);
    const wa = display.workArea;
    lastPetWindowState = {
      type: "PET_WINDOW_STATE",
      ts: Date.now(),
      size: { width: b.width, height: b.height },
      displayMode: displayModeConfig,
      bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
      workArea: { x: wa.x, y: wa.y, width: wa.width, height: wa.height }
    };

    // Controls UI (React console)
    if (controlsWindow && !controlsWindow.isDestroyed()) {
      try {
        controlsWindow.webContents.send(IPC_CHANNELS.petWindowState, lastPetWindowState);
      } catch {}
    }

    // Caption overlay: needs geometry to keep bubbles visible when peeking off-screen.
    try {
      if (!captionWindow.isDestroyed()) captionWindow.webContents.send(IPC_CHANNELS.petWindowState, lastPetWindowState);
    } catch {}

    // Pet renderer (inline fallback bubble can also benefit from this)
    try {
      if (!petWindow.isDestroyed()) petWindow.webContents.send(IPC_CHANNELS.petWindowState, lastPetWindowState);
    } catch {}
  };

  // initial state
  emitPetWindowState();

  // throttle resize updates
  let pendingResizeTimer: NodeJS.Timeout | null = null;
  petWindow.on("resize", () => {
    if (pendingResizeTimer) clearTimeout(pendingResizeTimer);
    pendingResizeTimer = setTimeout(() => {
      pendingResizeTimer = null;
      emitPetWindowState();
    }, 80);

    schedulePersistPetWindowSize();
  });

  // throttle move updates (needed for caption bubble visibility when peeking partially off-screen)
  let pendingMoveTimer: NodeJS.Timeout | null = null;
  petWindow.on("move", () => {
    if (pendingMoveTimer) clearTimeout(pendingMoveTimer);
    pendingMoveTimer = setTimeout(() => {
      pendingMoveTimer = null;
      emitPetWindowState();
    }, 80);
  });

  // IPC wiring
  ipcMain.on(IPC_CHANNELS.petControl, (_evt, payload: PetControlMessage) => {
    if (petWindow.isDestroyed()) return;
    if (payload && payload.type === "PET_CONTROL" && payload.action === "SET_PET_WINDOW_SIZE") {
      try {
        const cur = petWindow.getBounds();
        const size: any = (payload as any).size ?? {};
        const rawW = size.width;
        const rawH = size.height;
        const w = rawW === undefined ? cur.width : Math.round(Number(rawW));
        const h = rawH === undefined ? cur.height : Math.round(Number(rawH));
        if (!Number.isFinite(w) || !Number.isFinite(h)) throw new Error("invalid size");

        const [minW, minH] = petWindow.getMinimumSize();
        const nextW = Math.max(minW || 1, w);
        const nextH = Math.max(minH || 1, h);
        petWindow.setSize(nextW, nextH);
        schedulePersistPetWindowSize();
        emitPetWindowState();

        if (payload.requestId && controlsWindow && !controlsWindow.isDestroyed()) {
          const res: PetControlResult = {
            type: "PET_CONTROL_RESULT",
            ts: Date.now(),
            requestId: payload.requestId,
            ok: true
          };
          controlsWindow.webContents.send(IPC_CHANNELS.petControlResult, res);
        }
      } catch (err) {
        if (payload.requestId && controlsWindow && !controlsWindow.isDestroyed()) {
          const res: PetControlResult = {
            type: "PET_CONTROL_RESULT",
            ts: Date.now(),
            requestId: payload.requestId,
            ok: false,
            message: err instanceof Error ? err.message : String(err)
          };
          controlsWindow.webContents.send(IPC_CHANNELS.petControlResult, res);
        }
      }
      return;
    }

    // Handle display mode change
    if (payload && payload.type === "PET_CONTROL" && payload.action === "SET_DISPLAY_MODE") {
      try {
        const cfg: any = (payload as any).config ?? {};
        if (cfg.mode === "normal" || cfg.mode === "peek") displayModeConfig.mode = cfg.mode;

        // Current UX: "peek" = bottom-edge head peek. Force bottom edge to avoid confusing behavior.
        if (displayModeConfig.mode === "peek") {
          displayModeConfig.edge = "bottom";
        } else if (cfg.edge) {
          displayModeConfig.edge = cfg.edge;
        }

        if (typeof cfg.tiltDeg === "number") displayModeConfig.tiltDeg = cfg.tiltDeg;
        applyDisplayMode();
      } catch (err) {
        console.warn("[pet-window] SET_DISPLAY_MODE failed:", err);
      }
      return;
    }

    petWindow.webContents.send(IPC_CHANNELS.petControl, payload);
  });

  ipcMain.on(IPC_CHANNELS.petControlResult, (_evt, payload: PetControlResult) => {
    if (!controlsWindow || controlsWindow.isDestroyed()) return;
    controlsWindow.webContents.send(IPC_CHANNELS.petControlResult, payload);
  });

  ipcMain.on(IPC_CHANNELS.petStatus, (_evt, payload: PetStatusMessage) => {
    if (!controlsWindow || controlsWindow.isDestroyed()) return;
    controlsWindow.webContents.send(IPC_CHANNELS.petStatus, payload);
  });

  ipcMain.on(IPC_CHANNELS.petState, (_evt, payload: PetStateMessage) => {
    lastPetState = payload;
    if (!controlsWindow || controlsWindow.isDestroyed()) return;
    controlsWindow.webContents.send(IPC_CHANNELS.petState, payload);
  });

  ipcMain.on(IPC_CHANNELS.manualAction, (_evt, payload: ManualActionMessage) => {
    const parsed = ManualActionSchema.safeParse(payload);
    if (!parsed.success) return;

    const cmd: ActionCommand = {
      type: "ACTION_COMMAND",
      ts: parsed.data.ts || Date.now(),
      action: parsed.data.action,
      expression: parsed.data.expression ?? "NEUTRAL",
      bubble: null,
      durationMs: parsed.data.action === "APPROACH" || parsed.data.action === "RETREAT" ? 1500 : 1200
    };

    // Mirror the core dispatch behavior so the pet moves and the caption can react.
    petWindow.webContents.send(IPC_CHANNELS.actionCommand, cmd);
    captionWindow.webContents.send(IPC_CHANNELS.actionCommand, cmd);

    if (cmd.action === "APPROACH") moveTo(computeApproachTarget(), cmd.durationMs || 1500);
    if (cmd.action === "RETREAT") moveTo(homePosition, cmd.durationMs || 1500);
  });

  ipcMain.on(IPC_CHANNELS.userInteraction, (_evt, payload: UserInteraction) => {
    const parsed = UserInteractionSchema.safeParse(payload);
    if (!parsed.success) return;
    if (parsed.data.event === "CLICK_PET" || parsed.data.event === "OPEN_CHAT") {
      disarmPendingIgnore();
    }
    core.handleUserInteraction(parsed.data);
  });

  ipcMain.on(IPC_CHANNELS.dragDelta, (_evt, delta: DragDelta) => {
    const dx = Number((delta as any)?.dx ?? 0);
    const dy = Number((delta as any)?.dy ?? 0);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;

    const [x, y] = petWindow.getPosition();
    const nextX = Math.round(x + dx);
    const nextY = Math.round(y + dy);

    // In peek mode, keep the pet docked to the bottom edge; dragging only moves along X.
    if (displayModeConfig.mode === "peek") {
      peekHomePosition = { ...peekHomePosition, x: nextX };
      applyDisplayMode();
      return;
    }

    petWindow.setPosition(nextX, nextY);
    const [nx, ny] = petWindow.getPosition();
    normalHomePosition = { x: nx, y: ny };
    homePosition = { x: nx, y: ny };
    emitPetWindowState();
  });

  const broadcastChatLogSync = () => {
    const msg: ChatLogMessage = { type: "CHAT_LOG_SYNC", ts: Date.now(), entries: chatLog };
    try {
      controlsWindow?.webContents.send(IPC_CHANNELS.chatLog, msg);
    } catch {}
    try {
      chatWindow?.webContents.send(IPC_CHANNELS.chatLog, msg);
    } catch {}
  };

  // Long-term memory (SQLite) IPC ------------------------------------------------
  ipcMain.handle(IPC_HANDLES.memoryStatsGet, async () => memory.getMemoryStats());

  ipcMain.handle(IPC_HANDLES.memoryConfigGet, async () => ({
    enabled: memory.enabled,
    config: memory.getAgentMemoryConfig()
  }));

  ipcMain.handle(IPC_HANDLES.memoryConfigSet, async (_evt, payload: any) => {
    if (!memory.enabled) return { ok: false, config: memory.getAgentMemoryConfig() };
    const partial = isPlainObject(payload) ? payload : {};
    const res = memory.setAgentMemoryConfig(partial);
    return { ok: Boolean(res.ok), config: res.config };
  });

  ipcMain.handle(IPC_HANDLES.memoryNotesList, async (_evt, limitRaw: any) => {
    const limit = Math.max(1, Math.min(50, Math.floor(Number(limitRaw) || 0))) || 14;
    return { enabled: memory.enabled, notes: memory.listMemoryNotes(limit) };
  });

  ipcMain.handle(IPC_HANDLES.memoryNoteAdd, async (_evt, payload: any) => {
    const content = isPlainObject(payload) ? payload.content : payload;
    const ok = memory.upsertMemoryNote({ kind: "note", content: String(content ?? ""), ts: Date.now() });
    return { ok: Boolean(ok) };
  });

  ipcMain.handle(IPC_HANDLES.memoryNoteDelete, async (_evt, payload: any) => {
    if (!memory.enabled) return { ok: false };
    const id = Number(isPlainObject(payload) ? payload.id : payload);
    const ok = memory.deleteMemoryNoteById(id);
    return { ok: Boolean(ok) };
  });

  ipcMain.handle(IPC_HANDLES.memoryNoteUpdate, async (_evt, payload: any) => {
    if (!memory.enabled) return { ok: false };
    const id = Number(isPlainObject(payload) ? payload.id : 0);
    const content = String(isPlainObject(payload) ? payload.content : "").trim();
    const ok = memory.updateMemoryNoteById(id, content, Date.now());
    return { ok: Boolean(ok) };
  });

  ipcMain.handle(IPC_HANDLES.memoryFactsList, async (_evt, limitRaw: any) => {
    const limit = Math.max(1, Math.min(80, Math.floor(Number(limitRaw) || 0))) || 20;
    return { enabled: memory.enabled, facts: memory.listMemoryFacts(limit) };
  });

  ipcMain.handle(IPC_HANDLES.memoryFactUpsert, async (_evt, payload: any) => {
    if (!memory.enabled) return { ok: false };
    const fact = isPlainObject(payload) ? payload.fact : payload;
    const ok = memory.upsertMemoryFact({
      key: String(isPlainObject(fact) ? fact.key : ""),
      kind: String(isPlainObject(fact) ? fact.kind : ""),
      value: String(isPlainObject(fact) ? fact.value : ""),
      ts: Date.now()
    });
    return { ok: Boolean(ok) };
  });

  ipcMain.handle(IPC_HANDLES.memoryFactDelete, async (_evt, payload: any) => {
    if (!memory.enabled) return { ok: false };
    const id = Number(isPlainObject(payload) ? payload.id : payload);
    const ok = memory.deleteMemoryFactById(id);
    return { ok: Boolean(ok) };
  });

  ipcMain.handle(IPC_HANDLES.memoryFactUpdate, async (_evt, payload: any) => {
    if (!memory.enabled) return { ok: false };
    const id = Number(isPlainObject(payload) ? payload.id : 0);
    const value = String(isPlainObject(payload) ? payload.value : "").trim();
    const ok = memory.updateMemoryFactById(id, value, Date.now());
    return { ok: Boolean(ok) };
  });

  ipcMain.handle(IPC_HANDLES.memorySummaryGet, async () => {
    if (!memory.enabled) return { enabled: false, summary: "", summaryJson: null };
    const s = memory.getConversationSummary();
    return { enabled: true, summary: s.summary, summaryJson: s.summaryJson };
  });

  ipcMain.handle(IPC_HANDLES.memorySummaryClear, async () => {
    if (!memory.enabled) return { ok: false };
    try {
      memory.clearConversationSummary();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle(IPC_HANDLES.memoryClearChat, async () => {
    if (!memory.enabled) return { ok: false };
    try {
      memory.clearChatHistory();
      chatLog = [];
      core.clearChatHistory();
      broadcastChatLogSync();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle(IPC_HANDLES.memoryClearNotes, async () => {
    if (!memory.enabled) return { ok: false };
    try {
      memory.clearMemoryNotes();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle(IPC_HANDLES.memoryClearFacts, async () => {
    if (!memory.enabled) return { ok: false };
    try {
      memory.clearMemoryFacts();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle(IPC_HANDLES.chatInvoke, async (evt, payload: ChatRequest) => {
    const parsed = ChatRequestSchema.safeParse(payload);
    if (!parsed.success) return { type: "CHAT_RESPONSE", ts: Date.now(), message: "消息格式不对…" };

    const appendChat = (entry: ChatLogEntry) => {
      chatLog.push(entry);
      if (chatLog.length > 260) chatLog = chatLog.slice(-220);

      const msg: ChatLogMessage = { type: "CHAT_LOG_APPEND", ts: Date.now(), entry };

      // Always notify the sender window first (covers cases where controlsWindow is closed or re-created).
      try {
        evt.sender.send(IPC_CHANNELS.chatLog, msg);
      } catch {}

      // Also notify the main chat UI if it's a different window.
      if (controlsWindow && !controlsWindow.isDestroyed() && controlsWindow.webContents.id !== evt.sender.id) {
        controlsWindow.webContents.send(IPC_CHANNELS.chatLog, msg);
      }
    };

    // Broadcast user message immediately so the main chat UI feels responsive (even before LLM returns).
    const userEntry: ChatLogEntry = {
      id: `u_${parsed.data.ts}_${Math.random().toString(16).slice(2)}`,
      ts: parsed.data.ts,
      role: "user",
      content: parsed.data.message
    };
    appendChat(userEntry);

    const resp = await core.handleChat(parsed.data);
    const assistantEntry: ChatLogEntry = {
      id: `a_${resp.ts}_${Math.random().toString(16).slice(2)}`,
      ts: resp.ts,
      role: "assistant",
      content: resp.message
    };
    appendChat(assistantEntry);
    return resp;
  });

  petWindow.on("closed", () => app.quit());

  app.on("before-quit", () => {
    clearInterval(followTimer);
    if (pendingPersistTimer) clearTimeout(pendingPersistTimer);
    pendingPersistTimer = null;
    try {
      persistPetWindowSize();
    } catch {}
    shortcuts.dispose();
    tray.dispose();
    sensing.dispose();
  });

  setClickThrough(false);
  // The pet window is always-on-top and intentionally minimal.
  // Open the Controls window by default so the app is immediately operable.
  openControls();
}

void bootstrap();
