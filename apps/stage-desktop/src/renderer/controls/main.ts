import type { ActionCommand } from "@sama/shared";
import type { PetControlMessage, PetControlResult, PetStateMessage, PetStatusMessage } from "@sama/shared";
import { attachPetControls } from "../pet/controls";
import type { IdleConfig } from "../pet/idle";
import { DEFAULT_IDLE_CONFIG } from "../pet/idle";
import type { ModelTransform, MotionState, PetScene, VrmAnimationConfig, VrmAnimationSlotsStatus } from "../pet/scene";
import type { WalkConfig } from "../pet/walk";
import { DEFAULT_WALK_CONFIG } from "../pet/walk";

const bannerEl = document.getElementById("banner");
const banner = bannerEl instanceof HTMLDivElement ? bannerEl : null;

const rootEl = document.getElementById("root");
if (!(rootEl instanceof HTMLDivElement)) throw new Error("missing #root");
const root = rootEl;

let bannerTimer: number | null = null;
function showBanner(msg: string, opts?: { timeoutMs?: number }) {
  if (!banner) return;
  if (!msg) {
    banner.style.display = "none";
    return;
  }
  banner.textContent = msg;
  banner.style.display = "block";
  if (bannerTimer !== null) window.clearTimeout(bannerTimer);
  const ms = Math.max(900, Number(opts?.timeoutMs ?? 2600));
  bannerTimer = window.setTimeout(() => {
    banner.style.display = "none";
    bannerTimer = null;
  }, ms);
}

function formatErr(err: unknown) {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

type RemoteState = {
  vrmLoaded: boolean;
  motion: MotionState;
  slots: VrmAnimationSlotsStatus;
};

const remoteState: RemoteState = {
  vrmLoaded: false,
  motion: { locomotion: "IDLE", animation: "NONE" },
  slots: { hasLastLoaded: false, hasIdle: false, hasWalk: false, hasAction: false }
};

// A local mirror of the last applied configs so the UI can show meaningful initial values.
let modelTransform: ModelTransform = { scale: 1, yawDeg: 0, offsetX: 0, offsetY: 0, offsetZ: 0 };
let idleConfig: IdleConfig = { ...DEFAULT_IDLE_CONFIG };
let walkConfig: WalkConfig = { ...DEFAULT_WALK_CONFIG };
let vrmAnimationConfig: VrmAnimationConfig = { enabled: true, paused: false, speed: 1 };

const pendingResults = new Map<string, { resolve: (v: PetControlResult) => void; reject: (e: unknown) => void }>();

function createReqId() {
  return `req_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
}

const BC_NAME = "sama:pet-bus";
const bc = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(BC_NAME) : null;
let warnedFallback = false;

function getApi() {
  return (window as any).stageDesktop as any;
}

function sendViaBroadcast(payload: unknown) {
  if (!bc) return false;
  try {
    bc.postMessage(payload);
    return true;
  } catch {
    return false;
  }
}

function sendControl(msg: PetControlMessage) {
  const api = getApi();
  if (api && typeof api.sendPetControl === "function") {
    api.sendPetControl(msg);
    return true;
  }

  // Fallback: when preload is missing (or broken), still allow Controls <-> Pet communication in dev
  // by using BroadcastChannel between renderer windows. This keeps VRM/VRMA import usable.
  const ok = sendViaBroadcast(msg);
  if (!ok) {
    showBanner("preload API 不可用：无法控制 Pet（请检查 preload / contextIsolation）。", { timeoutMs: 3800 });
    return false;
  }

  if (!warnedFallback) {
    warnedFallback = true;
    showBanner("preload API 缺失：已切换为降级模式（BroadcastChannel，仅部分功能可用）。", { timeoutMs: 5200 });
  }
  return true;
}

type LoadControlMessage = Extract<PetControlMessage, { action: "LOAD_VRM_BYTES" | "LOAD_VRMA_BYTES" }>;

function sendControlWithResult(msg: Omit<LoadControlMessage, "requestId">) {
  const requestId = createReqId();
  const full = { ...(msg as any), requestId } as PetControlMessage;
  return new Promise<PetControlResult>((resolve, reject) => {
    let timer: number | null = null;
    const wrappedResolve = (v: PetControlResult) => {
      if (timer !== null) window.clearTimeout(timer);
      resolve(v);
    };
    const wrappedReject = (e: unknown) => {
      if (timer !== null) window.clearTimeout(timer);
      reject(e);
    };

    pendingResults.set(requestId, { resolve: wrappedResolve, reject: wrappedReject });
    timer = window.setTimeout(() => {
      pendingResults.delete(requestId);
      wrappedReject(new Error("Pet 无响应：请求超时（请检查桌宠窗口是否正常运行）"));
    }, 12_000);

    const ok = sendControl(full);
    if (!ok) {
      pendingResults.delete(requestId);
      wrappedReject(new Error("preload API 不可用：无法发送请求到 Pet"));
    }
  });
}

const remoteScene: PetScene = {
  start: () => {},
  setExpression: (_expr: ActionCommand["expression"]) => {},
  loadVrmBytes: async (bytes: Uint8Array) => {
    const res = await sendControlWithResult({ type: "PET_CONTROL", ts: Date.now(), action: "LOAD_VRM_BYTES", bytes });
    if (!res.ok) throw new Error(res.message || "VRM 加载失败");
  },
  loadVrmAnimationBytes: async (bytes: Uint8Array) => {
    const res = await sendControlWithResult({ type: "PET_CONTROL", ts: Date.now(), action: "LOAD_VRMA_BYTES", bytes });
    if (!res.ok) return false;
    return true;
  },
  speak: (_durationMs?: number) => sendControl({ type: "PET_CONTROL", ts: Date.now(), action: "SPEAK" }),
  refitCamera: () => sendControl({ type: "PET_CONTROL", ts: Date.now(), action: "REFIT_CAMERA" }),
  setIdleConfig: (cfg: Partial<IdleConfig>) => {
    idleConfig = { ...idleConfig, ...cfg };
    sendControl({ type: "PET_CONTROL", ts: Date.now(), action: "SET_IDLE_CONFIG", config: cfg });
  },
  getIdleConfig: () => (remoteState.vrmLoaded ? { ...idleConfig } : null),
  setWalkConfig: (cfg: Partial<WalkConfig>) => {
    walkConfig = { ...walkConfig, ...cfg };
    sendControl({ type: "PET_CONTROL", ts: Date.now(), action: "SET_WALK_CONFIG", config: cfg });
  },
  getWalkConfig: () => (remoteState.vrmLoaded ? { ...walkConfig } : null),
  setModelTransform: (t: Partial<ModelTransform>) => {
    modelTransform = { ...modelTransform, ...t };
    sendControl({ type: "PET_CONTROL", ts: Date.now(), action: "SET_MODEL_TRANSFORM", transform: t });
  },
  getModelTransform: () => ({ ...modelTransform }),
  setVrmAnimationConfig: (cfg: Partial<VrmAnimationConfig>) => {
    vrmAnimationConfig = { ...vrmAnimationConfig, ...cfg };
    sendControl({ type: "PET_CONTROL", ts: Date.now(), action: "SET_VRMA_CONFIG", config: cfg });
  },
  getVrmAnimationConfig: () => ({ ...vrmAnimationConfig }),
  clearVrmAnimation: () => sendControl({ type: "PET_CONTROL", ts: Date.now(), action: "CLEAR_VRMA_ACTION" }),
  setVrmAnimationSlotFromLast: (slot: "idle" | "walk") => {
    sendControl({ type: "PET_CONTROL", ts: Date.now(), action: "ASSIGN_VRMA_SLOT_FROM_LAST", slot });
    // Return a best-effort value; UI will reflect truth via `PET_STATE`.
    return true;
  },
  clearVrmAnimationSlot: (slot: "idle" | "walk") =>
    sendControl({ type: "PET_CONTROL", ts: Date.now(), action: "CLEAR_VRMA_SLOT", slot }),
  getVrmAnimationSlotsStatus: () => ({ ...remoteState.slots }),
  notifyAction: (cmd: ActionCommand) =>
    sendControl({ type: "PET_CONTROL", ts: Date.now(), action: "NOTIFY_ACTION", cmd }),
  setDragging: (_dragging: boolean) => {},
  notifyDragDelta: (_dx: number, _dy: number) => {},
  getMotionState: () => ({ ...remoteState.motion })
};

function renderNoPreloadHelp() {
  const isElectron = /\bElectron\b/i.test(navigator.userAgent);
  root.replaceChildren();

  const card = document.createElement("div");
  card.className = "panel";
  card.style.maxWidth = "780px";
  card.style.margin = "0 auto";

  const header = document.createElement("div");
  header.className = "panelHeader";

  const title = document.createElement("div");
  title.className = "panelTitle";
  title.textContent = "控制台未连接到桌宠";

  header.appendChild(title);
  card.appendChild(header);

  const body = document.createElement("div");
  body.className = "panelBody";

  const p1 = document.createElement("div");
  p1.style.color = "rgba(15, 23, 42, 0.9)";
  p1.textContent = isElectron
    ? "当前窗口是 Electron，但 preload API 缺失（可能是 preload 文件路径错误，或 preload 脚本运行报错）。"
    : "当前页面似乎是在浏览器中打开的（不是 Electron），因此无法使用 preload API。";

  const p2 = document.createElement("div");
  p2.style.color = "rgba(15, 23, 42, 0.64)";
  p2.style.fontSize = "12px";
  p2.textContent =
    "正确用法：运行 `pnpm dev` 后，去系统托盘找到 SAMA 图标 → 选择 `Open Controls`（或按 Ctrl+Alt+O）。不要直接用浏览器打开 http://localhost:5173/controls/index.html。";

  const diag = document.createElement("pre");
  diag.style.margin = "0";
  diag.style.padding = "10px 12px";
  diag.style.borderRadius = "12px";
  diag.style.border = "1px solid rgba(15, 23, 42, 0.12)";
  diag.style.background = "rgba(15, 23, 42, 0.04)";
  diag.style.color = "rgba(15, 23, 42, 0.78)";
  diag.style.fontSize = "12px";
  diag.style.whiteSpace = "pre-wrap";
  diag.textContent = `env: ${isElectron ? "electron" : "browser"}\nlocation: ${location.href}\nuserAgent: ${navigator.userAgent}`;

  body.append(p1, p2, diag);
  card.appendChild(body);
  root.appendChild(card);
}

function boot() {
  const api = getApi();
  const hasPreload = Boolean(api && typeof api.sendPetControl === "function");
  const hasBroadcast = Boolean(bc);

  if (!hasPreload && !hasBroadcast) {
    showBanner("preload API 缺失：控制台无法连接到 Pet。", { timeoutMs: 5200 });
    renderNoPreloadHelp();
    return;
  }

  if (!hasPreload && hasBroadcast) {
    showBanner("preload API 缺失：控制台将使用降级模式（BroadcastChannel，仅部分功能可用）。", { timeoutMs: 5200 });
  }

  // Receive status toasts
  const unsubs: Array<() => void> = [];

  if (hasPreload && typeof api.onPetStatus === "function") {
    unsubs.push(
      api.onPetStatus((s: PetStatusMessage) => {
        showBanner(s.message, { timeoutMs: s.level === "error" ? 5000 : 2400 });
      })
    );
  }

  if (hasPreload && typeof api.onPetState === "function") {
    unsubs.push(
      api.onPetState((s: PetStateMessage) => {
        remoteState.vrmLoaded = Boolean(s.vrmLoaded);
        remoteState.motion = s.motion;
        remoteState.slots = s.slots;
      })
    );
  }

  if (hasPreload && typeof api.onPetControlResult === "function") {
    unsubs.push(
      api.onPetControlResult((res: PetControlResult) => {
        const pending = pendingResults.get(res.requestId);
        if (!pending) return;
        pendingResults.delete(res.requestId);
        pending.resolve(res);
      })
    );
  }

  if (bc) {
    const handler = (evt: MessageEvent) => {
      const payload: any = (evt as any).data;
      if (!payload || typeof payload !== "object") return;

      if (payload.type === "PET_STATUS") {
        if (!hasPreload) {
          const level = payload.level === "error" ? "error" : "info";
          showBanner(String(payload.message ?? ""), { timeoutMs: level === "error" ? 5000 : 2400 });
        }
        return;
      }

      if (payload.type === "PET_STATE") {
        remoteState.vrmLoaded = Boolean(payload.vrmLoaded);
        remoteState.motion = payload.motion;
        remoteState.slots = payload.slots;
        return;
      }

      if (payload.type === "PET_CONTROL_RESULT") {
        const requestId = String(payload.requestId ?? "");
        if (!requestId) return;
        const pending = pendingResults.get(requestId);
        if (!pending) return;
        pendingResults.delete(requestId);
        pending.resolve(payload as PetControlResult);
      }
    };

    bc.addEventListener("message", handler);
    unsubs.push(() => bc.removeEventListener("message", handler));
  }

  attachPetControls({
    scene: remoteScene,
    root,
    onInfo: (msg) => showBanner(msg)
  });

  // Cleanup on close (not strictly necessary, but keeps the renderer tidy in dev HMR).
  window.addEventListener("beforeunload", () => {
    for (const u of unsubs) {
      try {
        u();
      } catch {}
    }
    for (const [, p] of pendingResults) p.reject(new Error("window closed"));
    pendingResults.clear();
    try {
      bc?.close();
    } catch {}
  });
}

try {
  boot();
} catch (err) {
  showBanner(`控制台启动失败：${formatErr(err)}`, { timeoutMs: 7000 });
  throw err;
}
