import { app, dialog, ipcMain, screen } from "electron";
import type { BrowserWindow, WebContents } from "electron";
import { BrowserWindow as ElectronBrowserWindow } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_MOTION_PRESET_ID, IPC_CHANNELS, IPC_HANDLES, MOTION_PRESET_CYCLE, getMotionPreset } from "@sama/shared";
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
  PetFrameConfig,
  PetStateMessage,
  PetStatusMessage,
  PetWindowSize,
  PetWindowStateMessage,
  MotionPresetId,
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
import { ClipboardMonitorService } from "./services/clipboard-monitor.service";
import { BatteryMonitorService } from "./services/battery-monitor.service";
import { ShortcutsService } from "./services/shortcuts.service";
import { TrayService } from "./services/tray.service";
import { SkillService } from "./services/skill.service";
import { ToolService } from "./services/tool.service";

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

type PersistedPetUiStateV1 = {
  version: 1;
  frame: { enabled: boolean; size: number; radius: number; color: string };
  motion: { defaultPresetId: MotionPresetId; cycleIdx: number };
};

const DEFAULT_PET_FRAME = { enabled: true, size: 3, radius: 12, color: "#d97757" } as const;
const DEFAULT_PET_MOTION = { defaultPresetId: DEFAULT_MOTION_PRESET_ID, cycleIdx: 0 } as const;

function sanitizeMotionPresetId(raw: unknown): MotionPresetId {
  const s = String(raw ?? "").trim() as MotionPresetId;
  return getMotionPreset(s) ? s : DEFAULT_MOTION_PRESET_ID;
}

function sanitizeFrameForPersistence(raw: unknown): PersistedPetUiStateV1["frame"] {
  const src = (raw && typeof raw === "object" ? (raw as any) : {}) as any;
  const enabled = typeof src.enabled === "boolean" ? src.enabled : DEFAULT_PET_FRAME.enabled;
  const size = Math.max(1, Math.min(10, Math.round(Number(src.size ?? DEFAULT_PET_FRAME.size))));
  const radius = Math.max(0, Math.min(50, Math.round(Number(src.radius ?? DEFAULT_PET_FRAME.radius))));
  const color = typeof src.color === "string" && src.color.trim() ? src.color.trim() : DEFAULT_PET_FRAME.color;
  return { enabled, size, radius, color };
}

function readPersistedPetUiState(statePath: string): PersistedPetUiStateV1 {
  try {
    const raw = readFileSync(statePath, "utf-8");
    const parsed: any = JSON.parse(raw);
    const frame = sanitizeFrameForPersistence(parsed?.frame);
    const motionRaw: any = parsed?.motion ?? {};
    const defaultPresetId = sanitizeMotionPresetId(motionRaw?.defaultPresetId);
    const cycleIdx = Math.max(0, Math.min(10_000, Math.floor(Number(motionRaw?.cycleIdx) || 0)));
    return { version: 1, frame, motion: { defaultPresetId, cycleIdx } };
  } catch {
    return { version: 1, frame: { ...DEFAULT_PET_FRAME }, motion: { ...DEFAULT_PET_MOTION } };
  }
}

function writePersistedPetUiState(statePath: string, state: PersistedPetUiStateV1) {
  try {
    const stable: PersistedPetUiStateV1 = {
      version: 1,
      frame: sanitizeFrameForPersistence(state.frame),
      motion: {
        defaultPresetId: sanitizeMotionPresetId(state.motion?.defaultPresetId),
        cycleIdx: Math.max(0, Math.min(10_000, Math.floor(Number(state.motion?.cycleIdx) || 0)))
      }
    };
    writeFileSync(statePath, JSON.stringify(stable, null, 2), "utf-8");
  } catch (err) {
    console.warn("[pet-ui] failed to persist state:", err);
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

  // TTS config (SpeechSynthesis in renderer; persisted so pet-only mode can still speak)
  if (isPlainObject((raw as any).tts)) {
    const b: any = (raw as any).tts;
    const out: any = {};
    if (typeof b.autoPlay === "boolean") out.autoPlay = b.autoPlay;
    if (typeof b.voice === "string") out.voice = b.voice; // allow empty string => auto
    if (b.rate !== undefined) {
      const n = Number(b.rate);
      if (Number.isFinite(n)) out.rate = Math.max(0.7, Math.min(1.35, n));
    }
    if (b.pitch !== undefined) {
      const n = Number(b.pitch);
      if (Number.isFinite(n)) out.pitch = Math.max(0.8, Math.min(1.5, n));
    }
    if (b.volume !== undefined) {
      const n = Number(b.volume);
      if (Number.isFinite(n)) out.volume = Math.max(0, Math.min(1, n));
    }
    cfg.tts = out;
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

  // Tools config (global allowlist + fs sandbox)
  if (isPlainObject((raw as any).tools)) {
    const b: any = (raw as any).tools;
    const out: any = {};
    if (Array.isArray(b.enabled)) {
      out.enabled = b.enabled.map((x: any) => String(x ?? "").trim()).filter((x: string) => x);
    }
    if (Array.isArray(b.fsRoots)) {
      out.fsRoots = b.fsRoots.map((x: any) => String(x ?? "").trim()).filter((x: string) => x);
    }
    if (b.maxReadBytes !== undefined) {
      const n = Math.floor(Number(b.maxReadBytes) || 0);
      if (Number.isFinite(n) && n > 0) out.maxReadBytes = Math.max(1000, Math.min(500_000, n));
    }
    cfg.tools = out;
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
    tts: { ...(base?.tts ?? {}), ...(override?.tts ?? {}) },
    skills: { ...(base?.skills ?? {}), ...(override?.skills ?? {}) },
    tools: { ...(base?.tools ?? {}), ...(override?.tools ?? {}) }
  };
}

function stripMarkdownForTts(md: string) {
  const s = String(md ?? "");

  // Drop tool_calls blocks entirely.
  let out = s.replace(/```tool_calls[\s\S]*?```/g, "");

  // Drop fenced code blocks entirely (TTS should not read code).
  out = out.replace(/```[\s\S]*?```/g, "");

  // Links: [text](url) -> text
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Inline code: `x` -> x
  out = out.replace(/`([^`]+)`/g, "$1");

  // Headings / quotes / list markers
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  out = out.replace(/^\s{0,3}>\s?/gm, "");
  out = out.replace(/^\s{0,3}([-*]|\d+\.)\s+/gm, "");

  // Emphasis markers
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
  out = out.replace(/\*([^*]+)\*/g, "$1");
  out = out.replace(/__([^_]+)__/g, "$1");
  out = out.replace(/_([^_]+)_/g, "$1");

  return out.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function pickFirstParagraphForTts(md: string) {
  const cleaned = stripMarkdownForTts(md);
  if (!cleaned) return "";
  const first = cleaned.split(/\n{2,}/)[0]?.trim() ?? "";
  // Keep it short so it feels like a cute "reply" rather than a long audiobook.
  const compact = first.replace(/\s+/g, " ").trim();
  return compact.length > 240 ? compact.slice(0, 240).trim() : compact;
}

function ttsOptionsFromCfg(cfg: any) {
  const t = cfg && typeof cfg === "object" ? cfg : {};
  const voice = typeof t.voice === "string" ? t.voice : "";
  const rate = typeof t.rate === "number" && Number.isFinite(t.rate) ? t.rate : 1.08;
  const pitch = typeof t.pitch === "number" && Number.isFinite(t.pitch) ? t.pitch : 1.12;
  const volume = typeof t.volume === "number" && Number.isFinite(t.volume) ? t.volume : 1;
  return { voice, rate, pitch, volume };
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
  const petUiStatePath = join(app.getPath("userData"), "pet-ui.json");
  let petUiState = readPersistedPetUiState(petUiStatePath);

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
    const toolSvc = new ToolService(effective ?? {});
    return {
      storagePath: llmConfigStatePath,
      stored: persistedLlmConfig,
      effective,
      provider: llm.providerName,
      skillsDir: skillSvc.skillsDir,
      availableSkills: skillSvc.listSkills().map((s) => s.name),
      availableTools: toolSvc.availableToolNames
    };
  });

  ipcMain.handle("handle:available-tools-get", async () => {
    const effective = mergeLlmConfig(baseLlmConfig, persistedLlmConfig);
    const toolSvc = new ToolService(effective ?? {});
    const { ALL_TOOLS } = await import("./services/tool.service");
    return {
      tools: ALL_TOOLS.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description
      }))
    };
  });

  ipcMain.handle("handle:available-skills-get", async () => {
    const effective = mergeLlmConfig(baseLlmConfig, persistedLlmConfig);
    const skillsDir = String(effective?.skills?.dir ?? "").trim() || undefined;
    const skillSvc = new SkillService({ skillsDir });
    return {
      skills: skillSvc.listSkills().map((s) => ({
        name: s.name,
        description: s.description || undefined
      }))
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

  type WindowBounds = { x: number; y: number; width: number; height: number };
  let lastCaptionBounds: WindowBounds | null = null;
  const setCaptionBounds = (b: WindowBounds) => {
    if (petWindow.isDestroyed() || captionWindow.isDestroyed()) return;
    if (!petWindow.isVisible()) return;
    const prev = lastCaptionBounds;
    if (prev && prev.x === b.x && prev.y === b.y && prev.width === b.width && prev.height === b.height) return;
    try {
      captionWindow.setBounds(b);
      lastCaptionBounds = { ...b };
    } catch {}
  };
  const syncCaptionBoundsToPet = () => {
    try {
      setCaptionBounds(petWindow.getBounds());
    } catch {}
  };

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
  syncCaptionBoundsToPet();

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
      if (controlsWindow.isMinimized()) controlsWindow.restore();
      controlsWindow.show();
      controlsWindow.focus();
      try {
        controlsWindow.moveTop();
      } catch {}
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

  const appendChatLogEntry = (entry: ChatLogEntry, sender?: WebContents | null) => {
    chatLog.push(entry);
    if (chatLog.length > 260) chatLog = chatLog.slice(-220);

    const msg: ChatLogMessage = { type: "CHAT_LOG_APPEND", ts: Date.now(), entry };

    // Always notify the sender window first (covers cases where Controls is closed or re-created).
    if (sender) {
      try {
        sender.send(IPC_CHANNELS.chatLog, msg);
      } catch {}
    }

    // Also notify other windows if they exist.
    if (controlsWindow && !controlsWindow.isDestroyed() && controlsWindow.webContents.id !== sender?.id) {
      try {
        controlsWindow.webContents.send(IPC_CHANNELS.chatLog, msg);
      } catch {}
    }
    if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents.id !== sender?.id) {
      try {
        chatWindow.webContents.send(IPC_CHANNELS.chatLog, msg);
      } catch {}
    }
  };

  ipcMain.handle("handle:controls-window-open", async () => {
    try {
      openControls();
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[controls] open failed:", err);
      try {
        dialog.showErrorBox("SAMA Controls open failed", msg);
      } catch {}
      return { ok: false, message: msg };
    }
  });

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
      syncCaptionBoundsToPet();
    }
  };

  const memory = new MemoryService({ dbPath: join(app.getPath("userData"), "memory.db") });
  await memory.init();

  // Restore chat history across restarts (long-term memory foundation).
  try {
    chatLog = memory.getRecentChatLogEntries(260);
  } catch {}

  let pendingIgnoreTimer: NodeJS.Timeout | null = null;
  let pendingIgnore: { action: "INVITE_CHAT"; cmdTs: number } | null = null;

  function disarmPendingIgnore() {
    if (pendingIgnoreTimer) clearTimeout(pendingIgnoreTimer);
    pendingIgnoreTimer = null;
    pendingIgnore = null;
  }

  function armPendingIgnore(action: "INVITE_CHAT", cmdTs: number, durationMs: number) {
    pendingIgnore = { action, cmdTs };
    pendingIgnoreTimer = setTimeout(() => {
      const p = pendingIgnore;
      if (!p || p.cmdTs !== cmdTs) return;
      disarmPendingIgnore();
      core?.handleUserInteraction({
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

      // Ignore detection: if a proactive INVITE_CHAT gets no response within duration,
      // emit IGNORED_ACTION back into the core.
      if (meta.proactive && cmd.action === "INVITE_CHAT") {
        disarmPendingIgnore();
        const ignoreMs = Math.max(60_000, Math.floor(Number(cmd.durationMs) || 0));
        armPendingIgnore("INVITE_CHAT", cmd.ts, ignoreMs);
      }
    },
    onProactiveChat: ({ ts, content }) => {
      const text = String(content ?? "").trim();
      if (!text) return;

      const entry: ChatLogEntry = {
        id: `p_${ts}_${Math.random().toString(16).slice(2)}`,
        ts: Number(ts) || Date.now(),
        role: "assistant",
        content: text
      };
      appendChatLogEntry(entry, null);

      // Optional: auto TTS (speak the first paragraph only).
      try {
        const effective = mergeLlmConfig(baseLlmConfig, persistedLlmConfig);
        const autoPlay = Boolean((effective as any)?.tts?.autoPlay ?? false);
        if (autoPlay && !petWindow.isDestroyed()) {
          const ttsText = pickFirstParagraphForTts(text);
          if (ttsText) {
            petWindow.webContents.send(IPC_CHANNELS.petControl, {
              type: "PET_CONTROL",
              ts: Date.now(),
              action: "SPEAK_TEXT",
              text: ttsText,
              options: ttsOptionsFromCfg((effective as any)?.tts)
            } as any);
          }
        }
      } catch {}
    }
  });
  core.setAssistantConfig(mergeLlmConfig(baseLlmConfig, persistedLlmConfig));

  const clipboardMonitor = new ClipboardMonitorService({
    enabled: true,
    onSignal: (sig) => void core?.handleProactiveSignal(sig as any)
  });
  clipboardMonitor.start();

  const batteryMonitor = new BatteryMonitorService({
    onSignal: (sig) => void core?.handleProactiveSignal(sig as any)
  });
  batteryMonitor.start();

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
    const display = (() => {
      try {
        return screen.getDisplayMatching(b);
      } catch {
        return screen.getPrimaryDisplay();
      }
    })();
    const wa = display.workArea;
    lastPetWindowState = {
      type: "PET_WINDOW_STATE",
      ts: Date.now(),
      size: { width: b.width, height: b.height },
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
    syncCaptionBoundsToPet();
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
    syncCaptionBoundsToPet();
    if (pendingMoveTimer) clearTimeout(pendingMoveTimer);
    pendingMoveTimer = setTimeout(() => {
      pendingMoveTimer = null;
      emitPetWindowState();
    }, 80);
  });

  // Persisted UI state for the pet window (frame + motion defaults).
  const persistPetUiState = () => writePersistedPetUiState(petUiStatePath, petUiState);

  const mergeFrameConfigForPersistence = (patch: PetFrameConfig) => {
    const next = { ...(petUiState.frame ?? DEFAULT_PET_FRAME) } as any;
    if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
    if (typeof patch.size === "number" && Number.isFinite(patch.size)) next.size = patch.size;
    if (typeof patch.radius === "number" && Number.isFinite(patch.radius)) next.radius = patch.radius;
    if (typeof patch.color === "string" && patch.color.trim()) next.color = patch.color.trim();
    petUiState.frame = sanitizeFrameForPersistence(next);
    persistPetUiState();
  };

  const resolveBundledAsset = (rel: string): string | null => {
    const candidates: string[] = [];

    // Monorepo root: apps/stage-desktop/assets/...
    candidates.push(resolve(process.cwd(), "apps", "stage-desktop", "assets", rel));
    // App dir (when cwd is apps/stage-desktop): assets/...
    candidates.push(resolve(process.cwd(), "assets", rel));

    // Production (asar / resources)
    try {
      candidates.push(join(app.getAppPath(), "assets", rel));
    } catch {}
    try {
      candidates.push(join(process.resourcesPath || "", "assets", rel));
    } catch {}

    // electron-vite dev/prod variants relative to compiled main bundle
    try {
      const base = dirname(import.meta.dirname || __dirname);
      candidates.push(resolve(base, "..", "assets", rel));
      candidates.push(resolve(base, "..", "..", "assets", rel));
      candidates.push(resolve(base, "..", "..", "..", "assets", rel));
      candidates.push(resolve(base, "..", "..", "..", "..", "assets", rel));
    } catch {}

    for (const p of candidates) {
      try {
        if (existsSync(p)) return p;
      } catch {}
    }
    return null;
  };

  const motionReqMeta = new Map<string, { presetId: MotionPresetId; presetName: string }>();

  const applyMotionPresetToPet = (presetId: MotionPresetId, opts?: { requestId?: string; replyTo?: WebContents }) => {
    const preset = getMotionPreset(presetId);
    const requestId = String(opts?.requestId ?? "").trim() || undefined;
    const replyTo = opts?.replyTo;

    const reply = (ok: boolean, message?: string) => {
      if (!requestId || !replyTo) return;
      try {
        if (replyTo.isDestroyed()) return;
        const res: PetControlResult = {
          type: "PET_CONTROL_RESULT",
          ts: Date.now(),
          requestId,
          ok,
          ...(message ? { message } : {})
        };
        replyTo.send(IPC_CHANNELS.petControlResult, res);
      } catch {}
    };

    if (!preset) {
      reply(false, `Unknown preset: ${presetId}`);
      return;
    }

    if (preset.kind === "idle_config") {
      // Reset any active VRMA override and apply a more natural procedural idle.
      petWindow.webContents.send(IPC_CHANNELS.petControl, { type: "PET_CONTROL", ts: Date.now(), action: "CLEAR_VRMA_ACTION" });
      petWindow.webContents.send(IPC_CHANNELS.petControl, {
        type: "PET_CONTROL",
        ts: Date.now(),
        action: "SET_IDLE_CONFIG",
        config: preset.idleConfig
      });
      reply(true, preset.name);
      return;
    }

    const assetRel = join("vrma", preset.assetFile).replace(/\\\\/g, "/");
    const assetPath = resolveBundledAsset(assetRel);
    if (!assetPath) {
      reply(false, `VRMA preset not found: ${preset.assetFile}`);
      return;
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(assetPath));
    } catch (err) {
      reply(false, err instanceof Error ? err.message : String(err));
      return;
    }

    if (requestId) motionReqMeta.set(requestId, { presetId, presetName: preset.name });

    petWindow.webContents.send(IPC_CHANNELS.petControl, {
      type: "PET_CONTROL",
      ts: Date.now(),
      ...(requestId ? { requestId } : {}),
      action: "LOAD_VRMA_BYTES",
      bytes
    });
  };

  const cycleMotionPreset = (): MotionPresetId => {
    const list = MOTION_PRESET_CYCLE;
    const idx = Math.max(0, Math.min(10_000, Math.floor(Number(petUiState.motion?.cycleIdx) || 0)));
    const pickedIdx = list.length ? idx % list.length : 0;
    const presetId = list.length ? list[pickedIdx]! : DEFAULT_MOTION_PRESET_ID;
    const nextIdx = list.length ? (pickedIdx + 1) % list.length : 0;
    petUiState.motion = {
      defaultPresetId: sanitizeMotionPresetId(petUiState.motion?.defaultPresetId),
      cycleIdx: nextIdx
    };
    persistPetUiState();
    return presetId;
  };

  // Apply persisted UI state as soon as the pet renderer is ready (no need to open Controls).
  const applyPersistedPetUiStateToRenderer = () => {
    try {
      petWindow.webContents.send(IPC_CHANNELS.petControl, {
        type: "PET_CONTROL",
        ts: Date.now(),
        action: "SET_FRAME_CONFIG",
        config: { ...petUiState.frame, previewing: false }
      });
    } catch {}

    try {
      // Start in a natural idle pose by default.
      const id = sanitizeMotionPresetId(petUiState.motion?.defaultPresetId);
      applyMotionPresetToPet(id);
    } catch {}
  };

  petWindow.webContents.on("did-finish-load", () => applyPersistedPetUiStateToRenderer());
  // `did-finish-load` may fire before this listener is attached (fast local loads).
  // If the renderer is already loaded, apply immediately.
  try {
    if (!petWindow.webContents.isLoading()) applyPersistedPetUiStateToRenderer();
  } catch {}
  // Extra safety: if both checks miss (platform quirks), re-apply once shortly after boot.
  setTimeout(() => {
    try {
      if (!petWindow.isDestroyed()) {
        petWindow.webContents.send(IPC_CHANNELS.petControl, {
          type: "PET_CONTROL",
          ts: Date.now(),
          action: "SET_FRAME_CONFIG",
          config: { ...petUiState.frame, previewing: false }
        });
      }
    } catch {}
  }, 650);

  // Route pet control results back to the window that initiated the request (pet/controls/chat),
  // while keeping backwards compatibility with the Controls window forwarding.
  const petControlReqToSender = new Map<string, WebContents>();

  // IPC wiring
  ipcMain.on(IPC_CHANNELS.petControl, (_evt, payload: PetControlMessage) => {
    if (petWindow.isDestroyed()) return;
    const reqId = String((payload as any)?.requestId ?? "").trim();
    if (reqId) {
      try {
        petControlReqToSender.set(reqId, (_evt as any).sender as WebContents);
      } catch {}
    }

    // Persist frame config so it applies on next launch without opening Controls.
    if (payload && payload.type === "PET_CONTROL" && payload.action === "SET_FRAME_CONFIG") {
      try {
        mergeFrameConfigForPersistence((payload as any).config ?? {});
      } catch {}
      petWindow.webContents.send(IPC_CHANNELS.petControl, payload);
      return;
    }

    // Built-in motion presets (handled in main so the pet window quick button works without Controls).
    if (payload && payload.type === "PET_CONTROL" && payload.action === "PLAY_MOTION_PRESET") {
      try {
        const presetId = sanitizeMotionPresetId((payload as any).presetId) as MotionPresetId;
        applyMotionPresetToPet(presetId, { requestId: reqId || undefined, replyTo: (_evt as any).sender as WebContents });
      } catch (err) {
        try {
          const sender = (_evt as any).sender as WebContents;
          if (reqId && sender && !sender.isDestroyed()) {
            const res: PetControlResult = {
              type: "PET_CONTROL_RESULT",
              ts: Date.now(),
              requestId: reqId,
              ok: false,
              message: err instanceof Error ? err.message : String(err)
            };
            sender.send(IPC_CHANNELS.petControlResult, res);
          }
        } catch {}
      }
      return;
    }

    if (payload && payload.type === "PET_CONTROL" && payload.action === "CYCLE_MOTION_PRESET") {
      try {
        const nextId = cycleMotionPreset();
        applyMotionPresetToPet(nextId, { requestId: reqId || undefined, replyTo: (_evt as any).sender as WebContents });
      } catch (err) {
        try {
          const sender = (_evt as any).sender as WebContents;
          if (reqId && sender && !sender.isDestroyed()) {
            const res: PetControlResult = {
              type: "PET_CONTROL_RESULT",
              ts: Date.now(),
              requestId: reqId,
              ok: false,
              message: err instanceof Error ? err.message : String(err)
            };
            sender.send(IPC_CHANNELS.petControlResult, res);
          }
        } catch {}
      }
      return;
    }

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
        syncCaptionBoundsToPet();
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

    // TTS speak: normalize text + apply current config (so the Controls window doesn't need to fetch settings).
    if (payload && payload.type === "PET_CONTROL" && payload.action === "SPEAK_TEXT") {
      try {
        const effective = mergeLlmConfig(baseLlmConfig, persistedLlmConfig);
        const cfgTts: any = (effective as any)?.tts ?? {};
        const rawText = String((payload as any).text ?? "");
        const text = pickFirstParagraphForTts(rawText);
        if (!text) return;
        const options = { ...ttsOptionsFromCfg(cfgTts), ...(((payload as any).options ?? {}) as any) };
        petWindow.webContents.send(IPC_CHANNELS.petControl, { ...(payload as any), text, options });
      } catch {
        // Fall back to passing through.
        petWindow.webContents.send(IPC_CHANNELS.petControl, payload);
      }
      return;
    }

    petWindow.webContents.send(IPC_CHANNELS.petControl, payload);
  });

  ipcMain.on(IPC_CHANNELS.petControlResult, (_evt, payload: PetControlResult) => {
    const reqId = String(payload?.requestId ?? "").trim();
    const meta = reqId ? motionReqMeta.get(reqId) : null;
    if (meta) {
      motionReqMeta.delete(reqId);
      if (payload.ok) {
        (payload as any).message = meta.presetName;
      } else {
        const m = String(payload.message ?? "");
        (payload as any).message = m ? `${meta.presetName}：${m}` : `${meta.presetName}：失败`;
      }
    }

    const sender = reqId ? petControlReqToSender.get(reqId) : null;
    if (reqId) petControlReqToSender.delete(reqId);

    if (sender && !sender.isDestroyed()) {
      try {
        sender.send(IPC_CHANNELS.petControlResult, payload);
      } catch {}
    }

    // Backwards compatible: also forward to Controls window if it's open (unless it was the sender already).
    if (controlsWindow && !controlsWindow.isDestroyed()) {
      try {
        if (!sender || sender.id !== controlsWindow.webContents.id) {
          controlsWindow.webContents.send(IPC_CHANNELS.petControlResult, payload);
        }
      } catch {}
    }
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
      durationMs: 1200
    };

    // Mirror the core dispatch behavior so the pet moves and the caption can react.
    petWindow.webContents.send(IPC_CHANNELS.actionCommand, cmd);
    captionWindow.webContents.send(IPC_CHANNELS.actionCommand, cmd);
  });

  ipcMain.on(IPC_CHANNELS.userInteraction, (_evt, payload: UserInteraction) => {
    const parsed = UserInteractionSchema.safeParse(payload);
    if (!parsed.success) return;
    if (parsed.data.event === "CLICK_PET" || parsed.data.event === "OPEN_CHAT") {
      disarmPendingIgnore();
    }
    core?.handleUserInteraction(parsed.data);
  });

  ipcMain.on(IPC_CHANNELS.dragDelta, (_evt, delta: DragDelta) => {
    try {
      const dx = Number((delta as any)?.dx ?? 0);
      const dy = Number((delta as any)?.dy ?? 0);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;

      const [x, y] = petWindow.getPosition();
      const nextX = Math.round(x + dx);
      const nextY = Math.round(y + dy);

      // Clamp to the current display workArea to avoid errors when dragging to/beyond the screen boundary.
      try {
        const [w, h] = petWindow.getSize();
        const bounds = { x: nextX, y: nextY, width: w, height: h };
        const display = (() => {
          try {
            return screen.getDisplayMatching(bounds);
          } catch {
            return screen.getPrimaryDisplay();
          }
        })();
        const wa = display.workArea;
        const margin = 4;
        const clampedX = Math.round(clamp(nextX, wa.x + margin, wa.x + wa.width - w - margin));
        const clampedY = Math.round(clamp(nextY, wa.y + margin, wa.y + wa.height - h - margin));
        petWindow.setPosition(clampedX, clampedY);
        setCaptionBounds({ x: clampedX, y: clampedY, width: w, height: h });
      } catch (err) {
        console.warn("[pet] dragDelta setPosition failed:", err);
        return;
      }
      emitPetWindowState();
    } catch (err) {
      console.warn("[pet] dragDelta failed:", err);
    }
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

    // A user message is a response to any pending proactive invite.
    disarmPendingIgnore();

    // Broadcast user message immediately so the main chat UI feels responsive (even before LLM returns).
    const userEntry: ChatLogEntry = {
      id: `u_${parsed.data.ts}_${Math.random().toString(16).slice(2)}`,
      ts: parsed.data.ts,
      role: "user",
      content: parsed.data.message,
      images: parsed.data.images,
      meta: parsed.data.meta
    };
    appendChatLogEntry(userEntry, evt.sender);

    const resp = await core.handleChat(parsed.data);
    const assistantEntry: ChatLogEntry = {
      id: `a_${resp.ts}_${Math.random().toString(16).slice(2)}`,
      ts: resp.ts,
      role: "assistant",
      content: resp.message
    };
    appendChatLogEntry(assistantEntry, evt.sender);

    // Optional: auto TTS (speak the first paragraph only).
    try {
      const effective = mergeLlmConfig(baseLlmConfig, persistedLlmConfig);
      const autoPlay = Boolean((effective as any)?.tts?.autoPlay ?? false);
      if (autoPlay && !petWindow.isDestroyed()) {
        const text = pickFirstParagraphForTts(resp.message);
        if (text) {
          petWindow.webContents.send(IPC_CHANNELS.petControl, {
            type: "PET_CONTROL",
            ts: Date.now(),
            action: "SPEAK_TEXT",
            text,
            options: ttsOptionsFromCfg((effective as any)?.tts)
          } as any);
        }
      }
    } catch {}
    return resp;
  });

  petWindow.on("closed", () => app.quit());

  app.on("before-quit", () => {
    if (pendingPersistTimer) clearTimeout(pendingPersistTimer);
    pendingPersistTimer = null;
    try {
      persistPetWindowSize();
    } catch {}
    shortcuts.dispose();
    tray.dispose();
    sensing.dispose();
    clipboardMonitor.dispose();
    batteryMonitor.dispose();
  });

  setClickThrough(false);
  // The pet window is always-on-top and intentionally minimal.
  // Open the Controls window by default so the app is immediately operable.
  openControls();
}

void bootstrap().catch((err) => {
  console.error("[main] bootstrap failed:", err);
  const msg = err instanceof Error ? err.stack || err.message : String(err);
  try {
    dialog.showErrorBox("SAMA bootstrap failed", msg);
  } catch {}
});
