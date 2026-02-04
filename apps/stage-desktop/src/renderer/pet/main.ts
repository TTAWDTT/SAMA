import type { ActionCommand, PetControlMessage, PetControlResult, PetStateMessage, PetStatusMessage } from "@sama/shared";
import { createPetScene } from "./scene";
import { attachPetInteractions } from "./ui";
import type { ModelTransform } from "./scene";

const hudEl = document.getElementById("hud");
const hud = hudEl instanceof HTMLDivElement ? hudEl : null;

const bannerEl = document.getElementById("banner");
const banner = bannerEl instanceof HTMLDivElement ? bannerEl : null;

const inlineBubbleEl = document.getElementById("inlineBubble");
const inlineBubble = inlineBubbleEl instanceof HTMLDivElement ? inlineBubbleEl : null;

const canvasEl = document.getElementById("canvas");
if (!(canvasEl instanceof HTMLCanvasElement)) throw new Error("missing #canvas");
const canvas = canvasEl;

const dropOverlayEl = document.getElementById("dropOverlay");
const dropOverlay = dropOverlayEl instanceof HTMLDivElement ? dropOverlayEl : null;
const dropHintEl = document.getElementById("dropHint");
const dropHint = dropHintEl instanceof HTMLDivElement ? dropHintEl : null;

const bootEl = document.getElementById("boot");
const bootRoot = bootEl instanceof HTMLDivElement ? bootEl : null;
const bootStatusEl = document.getElementById("bootStatus");
const bootStatus = bootStatusEl instanceof HTMLDivElement ? bootStatusEl : null;
const bootPickEl = document.getElementById("bootPick");
const bootPick = bootPickEl instanceof HTMLButtonElement ? bootPickEl : null;
const bootPickAnimEl = document.getElementById("bootPickAnim");
const bootPickAnim = bootPickAnimEl instanceof HTMLButtonElement ? bootPickAnimEl : null;
const bootCloseEl = document.getElementById("bootClose");
const bootClose = bootCloseEl instanceof HTMLButtonElement ? bootCloseEl : null;
const bootHintEl = document.getElementById("bootHint");
const bootHint = bootHintEl instanceof HTMLDivElement ? bootHintEl : null;

const hoverFrameEl = document.getElementById("hoverFrame");
const hoverFrame = hoverFrameEl instanceof HTMLDivElement ? hoverFrameEl : null;

// Quick action buttons
const btnCameraPresetEl = document.getElementById("btnCameraPreset");
const btnCameraPreset = btnCameraPresetEl instanceof HTMLButtonElement ? btnCameraPresetEl : null;
const btnDragMoveEl = document.getElementById("btnDragMove");
const btnDragMove = btnDragMoveEl instanceof HTMLButtonElement ? btnDragMoveEl : null;
const btnMotionEl = document.getElementById("btnMotion");
const btnMotion = btnMotionEl instanceof HTMLButtonElement ? btnMotionEl : null;
const btnExpressionEl = document.getElementById("btnExpression");
const btnExpression = btnExpressionEl instanceof HTMLButtonElement ? btnExpressionEl : null;
const btnOpenChatEl = document.getElementById("btnOpenChat");
const btnOpenChat = btnOpenChatEl instanceof HTMLButtonElement ? btnOpenChatEl : null;

const BC_NAME = "sama:pet-bus";
const bc = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(BC_NAME) : null;
let lastCaptionReadyAt = 0;

function isCaptionOverlayAlive() {
  if (!bc) return false;
  // Caption pings every ~2s; keep a little slack for jitter.
  return Date.now() - lastCaptionReadyAt < 5500;
}

function setHud(s: string) {
  if (!hud) return;
  hud.textContent = s;
}

let bannerTimer: number | null = null;
function showBanner(s: string, opts?: { timeoutMs?: number }) {
  if (!banner) return;
  if (!s) {
    banner.style.display = "none";
    return;
  }
  banner.textContent = s;
  banner.style.display = "block";
  if (bannerTimer !== null) window.clearTimeout(bannerTimer);
  const ms = Math.max(650, Number(opts?.timeoutMs ?? 2200));
  bannerTimer = window.setTimeout(() => {
    banner.style.display = "none";
    bannerTimer = null;
  }, ms);
}

type BubbleAnchor = { nx: number; ny: number };

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

let inlineBubbleVisible = false;
let inlineBubbleAnchor: BubbleAnchor = { nx: 0.5, ny: 0.22 };
let inlineBubbleHideTimer: number | null = null;

function layoutInlineBubble() {
  if (!inlineBubble || !inlineBubbleVisible) return;

  const vw = Math.max(1, window.innerWidth || 1);
  const vh = Math.max(1, window.innerHeight || 1);

  const rect = inlineBubble.getBoundingClientRect();
  const bw = Math.max(1, rect.width || inlineBubble.offsetWidth || 1);
  const bh = Math.max(1, rect.height || inlineBubble.offsetHeight || 1);

  const margin = 14;
  // Keep the bubble away from the avatar head so we don't cover it.
  const gap = 20;

  const anchorX = clamp(clamp01(inlineBubbleAnchor.nx), 0, 1) * vw;
  const anchorY = clamp(clamp01(inlineBubbleAnchor.ny), 0, 1) * vh;

  type Placement = "top" | "bottom" | "left" | "right";

  // Prefer side placement; allow vertical clamping, so only require X/Y room.
  const canPlaceRight = anchorX + gap + bw <= vw - margin;
  const canPlaceLeft = anchorX - gap - bw >= margin;
  const canPlaceTop = anchorY - gap - bh >= margin;
  const canPlaceBottom = anchorY + gap + bh <= vh - margin;

  // Prefer side placement so the bubble sits next to the head, not on top of it.
  let placement: Placement = "right";
  if (canPlaceRight) placement = "right";
  else if (canPlaceLeft) placement = "left";
  else if (canPlaceTop) placement = "top";
  else if (canPlaceBottom) placement = "bottom";
  else placement = "top";

  let x = anchorX;
  let y = anchorY;
  if (placement === "top") {
    x = clamp(anchorX, margin + bw / 2, vw - margin - bw / 2);
    y = clamp(anchorY - gap, margin + bh, vh - margin);
  } else if (placement === "bottom") {
    x = clamp(anchorX, margin + bw / 2, vw - margin - bw / 2);
    y = clamp(anchorY + gap, margin, vh - margin - bh);
  } else if (placement === "right") {
    x = clamp(anchorX + gap, margin, vw - margin - bw);
    y = clamp(anchorY, margin + bh / 2, vh - margin - bh / 2);
  } else {
    // left
    x = clamp(anchorX - gap, margin + bw, vw - margin);
    y = clamp(anchorY, margin + bh / 2, vh - margin - bh / 2);
  }

  inlineBubble.dataset.placement = placement;
  inlineBubble.style.setProperty("--bx", `${x.toFixed(2)}px`);
  inlineBubble.style.setProperty("--by", `${y.toFixed(2)}px`);
}

function setInlineBubbleAnchor(a: BubbleAnchor) {
  inlineBubbleAnchor = { nx: clamp01(Number(a?.nx ?? 0.5)), ny: clamp01(Number(a?.ny ?? 0.22)) };
  layoutInlineBubble();
}

function hideInlineBubble() {
  if (!inlineBubble) return;
  inlineBubble.classList.remove("show");
  inlineBubble.textContent = "";
  inlineBubbleVisible = false;
}

function showInlineBubble(text: string, durationMs: number) {
  if (!inlineBubble) return;
  inlineBubble.textContent = text;
  inlineBubble.classList.add("show");
  inlineBubbleVisible = true;

  // Layout after DOM updates so we can measure bubble size.
  requestAnimationFrame(() => layoutInlineBubble());

  if (inlineBubbleHideTimer !== null) window.clearTimeout(inlineBubbleHideTimer);
  inlineBubbleHideTimer = window.setTimeout(() => {
    inlineBubbleHideTimer = null;
    hideInlineBubble();
  }, Math.max(80, Number(durationMs) || 0));
}

window.addEventListener("resize", () => {
  if (!inlineBubbleVisible) return;
  layoutInlineBubble();
});

function setDropOverlayActive(active: boolean) {
  if (!dropOverlay) return;
  dropOverlay.setAttribute("data-active", active ? "1" : "0");
}

type HudState = {
  hasPreloadApi: boolean;
  canSendDragDelta: boolean;
  clickThrough: boolean | null;
  vrmLoaded: boolean;
  vrmaLoaded: boolean;
  lastDrag?: { dx: number; dy: number; at: number };
  lastNoIpcWarnAt?: number;
};

const hudState: HudState = {
  hasPreloadApi: false,
  canSendDragDelta: false,
  clickThrough: null,
  vrmLoaded: false,
  vrmaLoaded: false
};

function renderHud() {
  if (!hud) return;
  const lines: string[] = [];
  lines.push(`preload: ${hudState.hasPreloadApi ? "OK" : "MISSING"}`);
  lines.push(`drag: ${hudState.canSendDragDelta ? "IPC" : "fallback(handle)"}`);
  lines.push(`click-through: ${hudState.clickThrough === null ? "?" : hudState.clickThrough ? "ON" : "OFF"}`);
  lines.push(`vrm: ${hudState.vrmLoaded ? "loaded" : "none"}`);
  lines.push(`vrma: ${hudState.vrmaLoaded ? "loaded" : "none"}`);
  if (hudState.lastDrag) {
    lines.push(`last drag: ${hudState.lastDrag.dx}, ${hudState.lastDrag.dy}`);
  }
  hud.textContent = lines.join("\n");
}

let hudRaf: number | null = null;
function scheduleRenderHud() {
  if (!hud) return;
  if (hudRaf !== null) return;
  hudRaf = window.requestAnimationFrame(() => {
    hudRaf = null;
    renderHud();
  });
}

function setBootStatus(s: string) {
  if (!bootStatus) return;
  bootStatus.textContent = s;
  // The boot card can be closed; the banner remains a reliable feedback channel.
  showBanner(s);
}

function sendPetStatus(level: PetStatusMessage["level"], message: string) {
  const payload: PetStatusMessage = { type: "PET_STATUS", ts: Date.now(), level, message };
  try {
    (window as any).stageDesktop?.sendPetStatus?.(payload);
  } catch {}
  try {
    bc?.postMessage(payload);
  } catch {}
}

function sendPetControlResult(requestId: string | undefined, ok: boolean, message?: string, data?: Record<string, unknown>) {
  if (!requestId) return;
  const payload: PetControlResult = { type: "PET_CONTROL_RESULT", ts: Date.now(), requestId, ok, message, ...(data ? { data } : {}) };
  try {
    (window as any).stageDesktop?.sendPetControlResult?.(payload);
  } catch {}
  try {
    bc?.postMessage(payload);
  } catch {}
}

function formatErr(err: unknown) {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

const SETTINGS_KEY = "sama.pet.controls.v1";
function persistModelTransform(t: Partial<ModelTransform>) {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? (JSON.parse(raw) as any) : null;
    const next = parsed && parsed.version === 1 ? parsed : { version: 1 };
    next.modelTransform = { ...(next.modelTransform ?? {}), ...t };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

async function pickBytesViaFileInput(accept: string): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    document.body.appendChild(input);

    input.addEventListener(
      "change",
      async () => {
        try {
          const file = input.files?.[0];
          if (!file) {
            resolve(new Uint8Array());
            return;
          }
          const buf = await file.arrayBuffer();
          resolve(new Uint8Array(buf));
        } catch {
          resolve(new Uint8Array());
        } finally {
          input.remove();
        }
      },
      { once: true }
    );

    input.click();
  });
}

async function pickVrmBytes(): Promise<Uint8Array> {
  const api: any = (window as any).stageDesktop;
  if (api && typeof api.getVrmBytes === "function") {
    return api.getVrmBytes();
  }

  setBootStatus("未检测到 preload API（window.stageDesktop）。请点击“选择 VRM…” 手动选择文件。");
  return new Uint8Array();
}

async function boot() {
  const api: any = (window as any).stageDesktop;
  hudState.hasPreloadApi = !!api;
  hudState.canSendDragDelta = !!(api && typeof api.sendDragDelta === "function");
  renderHud();

  // Register pet-control listeners ASAP so we don't miss early IPC messages
  // (e.g. persisted frame config / initial motion preset sent on window load).
  const renderHoverFrame = () => {
    if (!hoverFrame) return;

    // Baseline styles (JS fallback). Even if CSS fails to load/parse, the frame should still work.
    hoverFrame.style.position = "fixed";
    hoverFrame.style.inset = "4px";
    hoverFrame.style.pointerEvents = "none";
    hoverFrame.style.boxSizing = "border-box";
    hoverFrame.style.borderStyle = "solid";
    hoverFrame.style.zIndex = "55";
    if (!hoverFrame.style.transition) hoverFrame.style.transition = "opacity 180ms ease";

    const enabled = hoverFrame.classList.contains("enabled");
    const previewing = hoverFrame.classList.contains("previewing");
    hoverFrame.style.opacity = enabled ? (previewing ? "1" : "0.9") : "0";
  };

  const applyFrameConfig = (cfg: any) => {
    const raw = cfg && typeof cfg === "object" ? cfg : {};
    if (!hoverFrame) return;

    // Only toggle enabled class when explicitly set (not undefined)
    if (raw.enabled === true) {
      hoverFrame.classList.add("enabled");
    } else if (raw.enabled === false) {
      hoverFrame.classList.remove("enabled");
      hoverFrame.classList.remove("previewing");
    }

    if (typeof raw.size === "number" && Number.isFinite(raw.size)) {
      hoverFrame.style.borderWidth = `${raw.size}px`;
    } else if (!hoverFrame.style.borderWidth) {
      hoverFrame.style.borderWidth = "3px";
    }

    if (typeof raw.radius === "number" && Number.isFinite(raw.radius)) {
      hoverFrame.style.borderRadius = `${raw.radius}px`;
    } else if (!hoverFrame.style.borderRadius) {
      hoverFrame.style.borderRadius = "16px";
    }

    if (typeof raw.color === "string") {
      hoverFrame.style.borderColor = raw.color;
    } else if (!hoverFrame.style.borderColor) {
      hoverFrame.style.borderColor = "#d97757";
    }

    // Show frame while adjusting settings (previewing mode)
    if (raw.previewing === true) {
      hoverFrame.classList.add("previewing");
    } else if (raw.previewing === false) {
      hoverFrame.classList.remove("previewing");
    }

    renderHoverFrame();
  };

  // Ensure the frame is styled on boot (even before any IPC arrives).
  renderHoverFrame();

  const pendingPetControls: PetControlMessage[] = [];
  let petControlDrain: Promise<void> = Promise.resolve();
  let handlePetControlReady: null | ((msg: PetControlMessage) => void) = null;

  const dispatchPetControl = (msg: PetControlMessage) => {
    if (!msg || msg.type !== "PET_CONTROL") return;

    // Frame config does not depend on the 3D scene; apply immediately to avoid "missing border" on boot.
    if (msg.action === "SET_FRAME_CONFIG") {
      applyFrameConfig((msg as any).config ?? {});
      return;
    }

    const sink = handlePetControlReady;
    if (sink) {
      sink(msg);
      return;
    }

    // Queue until the scene is ready and the full handler is installed.
    pendingPetControls.push(msg);
  };

  const unsubPetControl = api && typeof api.onPetControl === "function"
    ? api.onPetControl((msg: PetControlMessage) => dispatchPetControl(msg))
    : null;

  if (bc) {
    const bcHandler = (evt: MessageEvent) => {
      const msg: any = (evt as any).data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "CAPTION_READY") {
        lastCaptionReadyAt = Date.now();
        return;
      }
      if (msg.type !== "PET_CONTROL") return;
      dispatchPetControl(msg as PetControlMessage);
    };
    bc.addEventListener("message", bcHandler);
  }

  setBootStatus("正在启动渲染…（可稍后用“选择 VRM…”或拖拽导入）");

  const scene = await createPetScene(canvas, new Uint8Array());
  // Start rendering immediately so the window is not fully transparent while waiting for file pick / IPC.
  setHud("render: running");
  scene.start();

  const bootStartedAt = performance.now();
  let bootDismissed = false;
  const dismissBootOverlay = async (opts?: { minMs?: number }) => {
    if (!bootRoot || bootDismissed) return;
    if (bootRoot.getAttribute("data-hidden") === "1") {
      bootDismissed = true;
      return;
    }

    // Avoid flicker: ensure the splash stays visible for a minimum time, then wait a couple of frames
    // so the first fully-rendered VRM frame is likely on-screen before fading out.
    const minMs = Math.max(0, Math.floor(Number(opts?.minMs ?? 1200)));
    const elapsed = performance.now() - bootStartedAt;
    if (elapsed < minMs) {
      await new Promise((r) => window.setTimeout(r, Math.round(minMs - elapsed)));
    }
    await new Promise((r) => window.requestAnimationFrame(() => r(null)));
    await new Promise((r) => window.requestAnimationFrame(() => r(null)));

    bootRoot.setAttribute("data-hidden", "1");
    bootDismissed = true;
  };

  // Throttle drag IPC to 1 message per frame to avoid flooding the main process.
  let pendingDragDx = 0;
  let pendingDragDy = 0;
  let dragRaf: number | null = null;
  const flushDragDelta = () => {
    dragRaf = null;
    const dx = pendingDragDx;
    const dy = pendingDragDy;
    pendingDragDx = 0;
    pendingDragDy = 0;
    if (!dx && !dy) return;
    const api: any = (window as any).stageDesktop;
    try {
      api?.sendDragDelta?.({ dx, dy });
    } catch {}
  };
  const queueDragDelta = (dx: number, dy: number) => {
    pendingDragDx += dx;
    pendingDragDy += dy;
    if (dragRaf !== null) return;
    dragRaf = window.requestAnimationFrame(flushDragDelta);
  };

  // ====== TTS (SpeechSynthesis) ======
  const hasSpeechSynthesis = typeof window !== "undefined" && typeof (window as any).speechSynthesis !== "undefined";
  let ttsMouthTimer: number | null = null;

  const stopTtsMouth = () => {
    if (ttsMouthTimer !== null) window.clearInterval(ttsMouthTimer);
    ttsMouthTimer = null;
  };

  const startTtsMouth = () => {
    scene.speak(1200);
    stopTtsMouth();
    // Keep mouth moving while the utterance is active.
    ttsMouthTimer = window.setInterval(() => scene.speak(1200), 900);
  };

  const stopTts = () => {
    stopTtsMouth();
    if (!hasSpeechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
    } catch {}
  };

  const getVoicesReady = async (timeoutMs: number) => {
    if (!hasSpeechSynthesis) return [] as SpeechSynthesisVoice[];

    const synth = window.speechSynthesis;
    try {
      const v0 = synth.getVoices();
      if (Array.isArray(v0) && v0.length) return v0;
    } catch {}

    return await new Promise<SpeechSynthesisVoice[]>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try {
          synth.onvoiceschanged = null;
        } catch {}
        try {
          const v = synth.getVoices();
          resolve(Array.isArray(v) ? v : []);
        } catch {
          resolve([]);
        }
      };

      const t = window.setTimeout(finish, Math.max(100, timeoutMs));
      try {
        synth.onvoiceschanged = () => {
          window.clearTimeout(t);
          finish();
        };
      } catch {
        window.clearTimeout(t);
        finish();
      }
    });
  };

  const pickBestVoice = (voices: SpeechSynthesisVoice[], preferredName?: string) => {
    const pref = String(preferredName ?? "").trim();
    if (pref) {
      const exact = voices.find((v) => v && (v.name === pref || (v as any).voiceURI === pref));
      if (exact) return exact;
      const lower = pref.toLowerCase();
      const fuzzy = voices.find((v) => v && String(v.name ?? "").toLowerCase().includes(lower));
      if (fuzzy) return fuzzy;
    }

    const femaleHints = ["xiaoxiao", "huihui", "xiaoyi", "yaoyao", "meimei", "yating", "jiajia", "xiaohan"];

    const score = (v: SpeechSynthesisVoice) => {
      const name = String(v?.name ?? "").toLowerCase();
      const lang = String(v?.lang ?? "").toLowerCase();
      let s = 0;
      if (lang.startsWith("zh")) s += 120;
      if (lang.includes("zh-cn") || lang.includes("cmn")) s += 20;
      if (name.includes("natural") || name.includes("online")) s += 18;
      if (femaleHints.some((h) => name.includes(h))) s += 26;
      if (name.includes("female") || name.includes("girl")) s += 10;
      if (name.includes("male") || name.includes("man")) s -= 18;
      if (v.default) s += 2;
      return s;
    };

    const sorted = [...voices].sort((a, b) => score(b) - score(a));
    return sorted[0] ?? null;
  };

  const speakText = async (text: string, options?: { voice?: string; rate?: number; pitch?: number; volume?: number }) => {
    const s = String(text ?? "").trim();
    if (!s) return;

    // Always interrupt the previous utterance.
    stopTts();

    if (!hasSpeechSynthesis || typeof SpeechSynthesisUtterance === "undefined") {
      // Fallback: mouth only.
      scene.speak(Math.max(900, Math.min(3200, Math.floor(s.length * 70))));
      return;
    }

    const voices = await getVoicesReady(1200);
    const voice = pickBestVoice(voices, options?.voice);

    const u = new SpeechSynthesisUtterance(s);
    u.lang = voice?.lang || "zh-CN";
    if (voice) u.voice = voice;
    u.rate = clamp(Number(options?.rate ?? 1.08) || 1.08, 0.7, 1.35);
    u.pitch = clamp(Number(options?.pitch ?? 1.12) || 1.12, 0.8, 1.5);
    u.volume = clamp(Number(options?.volume ?? 1) || 1, 0, 1);

    u.onstart = () => startTtsMouth();
    const onDone = () => stopTtsMouth();
    u.onend = onDone;
    u.onerror = onDone;

    try {
      window.speechSynthesis.speak(u);
      // Some platforms don't reliably fire onstart; kick mouth quickly.
      window.setTimeout(() => {
        if (ttsMouthTimer === null) startTtsMouth();
      }, 80);
    } catch {
      // Fallback: mouth only.
      scene.speak(Math.max(900, Math.min(3200, Math.floor(s.length * 70))));
    }
  };

  // Read app flags (e.g., VRM locked). Do not block rendering if anything goes wrong.
  const appInfo = await (async () => {
    try {
      return api && typeof api.getAppInfo === "function" ? await api.getAppInfo() : null;
    } catch {
      return null;
    }
  })();
  const vrmLocked = Boolean(appInfo?.vrmLocked);

  if (vrmLocked) {
    // In locked mode, hide UI affordances that suggest you can switch VRM models.
    if (bootPick) bootPick.style.display = "none";
    if (bootHint) {
      bootHint.textContent = "模型已锁定：支持拖拽/导入 .vrma 动作；Click-through：Ctrl+Alt+P；控制台：Ctrl+Alt+O";
    }
    if (dropHint) {
      dropHint.textContent = ".vrma = 动作（加载后可设为 Idle/Walk 槽位）";
    }
    setBootStatus("模型已锁定（VRM 固定）。支持导入 VRMA 动作；拖拽/选择 VRM 将被忽略。");
  }

  // Persist model transform updates caused by direct manipulation (Shift-drag pan).
  let persistTimer: number | null = null;
  const schedulePersist = () => {
    if (persistTimer !== null) window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
      persistTimer = null;
      const t = scene.getModelTransform();
      persistModelTransform({ offsetX: t.offsetX, offsetY: t.offsetY, offsetZ: t.offsetZ });
    }, 180);
  };

  // While a caption bubble is visible, keep sending the anchor so the caption window can follow the character head.
  let anchorTimer: number | null = null;
  let anchorUntilTs = 0;
  let lastPostedAnchor: { nx: number; ny: number } | null = null;
  let lastPostedAnchorAt = 0;
  const postCaptionAnchor = () => {
    const a = scene.getBubbleAnchor?.();
    if (!a) return;
    if (inlineBubbleVisible) setInlineBubbleAnchor(a);

    const now = Date.now();
    const prev = lastPostedAnchor;
    if (prev) {
      const dx = Math.abs(a.nx - prev.nx);
      const dy = Math.abs(a.ny - prev.ny);
      // Avoid spamming when the anchor is stable; still refresh periodically.
      if (dx < 0.003 && dy < 0.003 && now - lastPostedAnchorAt < 700) return;
    }
    lastPostedAnchor = { nx: a.nx, ny: a.ny };
    lastPostedAnchorAt = now;
    try {
      bc?.postMessage({ type: "CAPTION_ANCHOR", ts: now, nx: a.nx, ny: a.ny });
    } catch {}
  };
  const startCaptionAnchorTracking = (durationMs: number) => {
    const now = Date.now();
    const ms = Math.max(400, Number(durationMs) || 0);
    // Replace the active window rather than extending forever:
    // - thinking indicator -> replace with reply bubble
    // - bubble -> replace with next bubble
    anchorUntilTs = now + ms;
    postCaptionAnchor();
    if (anchorTimer !== null) return;
    anchorTimer = window.setInterval(() => {
      if (Date.now() > anchorUntilTs) {
        if (anchorTimer !== null) window.clearInterval(anchorTimer);
        anchorTimer = null;
        return;
      }
      postCaptionAnchor();
    }, 120);
  };

  let lastPetStateSig = "";
  let lastPetStateSentAt = 0;
  const emitPetState = (opts?: { force?: boolean }) => {
    const payload: PetStateMessage = {
      type: "PET_STATE",
      ts: Date.now(),
      vrmLoaded: Boolean(hudState.vrmLoaded),
      motion: scene.getMotionState(),
      slots: scene.getVrmAnimationSlotsStatus()
    };

    const sig =
      `${payload.vrmLoaded ? 1 : 0}|${payload.motion.locomotion}|${payload.motion.animation}|` +
      `${payload.slots.hasLastLoaded ? 1 : 0}${payload.slots.hasIdle ? 1 : 0}${payload.slots.hasWalk ? 1 : 0}${payload.slots.hasAction ? 1 : 0}`;
    const now = Date.now();
    if (!opts?.force && sig === lastPetStateSig && now - lastPetStateSentAt < 2500) return;
    lastPetStateSig = sig;
    lastPetStateSentAt = now;

    try {
      (window as any).stageDesktop?.sendPetState?.(payload);
    } catch {}
    try {
      bc?.postMessage(payload);
    } catch {}
  };
  const sendPetState = () => emitPetState({ force: true });

  // Keep the Controls window updated (even if it opens later).
  const petStateTimer = window.setInterval(() => emitPetState({ force: false }), 650);
  window.addEventListener("beforeunload", () => {
    window.clearInterval(petStateTimer);
    if (persistTimer !== null) window.clearTimeout(persistTimer);
    if (anchorTimer !== null) window.clearInterval(anchorTimer);
    if (hudRaf !== null) window.cancelAnimationFrame(hudRaf);
    if (dragRaf !== null) window.cancelAnimationFrame(dragRaf);
    try {
      unsubPetControl?.();
    } catch {}
    try {
      bc?.close();
    } catch {}
  });

  type Expression = ActionCommand["expression"];
  const expressionOrder: Expression[] = [
    "NEUTRAL",
    "HAPPY",
    "SHY",
    "THINKING",
    "EXCITED",
    "SURPRISED",
    "TIRED",
    "CONFUSED",
    "SAD",
    "ANGRY"
  ];
  const expressionLabels: Record<Expression, string> = {
    NEUTRAL: "自然",
    HAPPY: "开心",
    SAD: "难过",
    SHY: "害羞",
    TIRED: "困困",
    ANGRY: "生气",
    SURPRISED: "惊讶",
    THINKING: "思考",
    CONFUSED: "迷糊",
    EXCITED: "兴奋"
  };
  const expressionIcons: Record<Expression, string> = {
    NEUTRAL: "🙂",
    HAPPY: "😊",
    SAD: "😢",
    SHY: "😳",
    TIRED: "😴",
    ANGRY: "😠",
    SURPRISED: "😮",
    THINKING: "🤔",
    CONFUSED: "😕",
    EXCITED: "😆"
  };
  let currentExpression: Expression = "NEUTRAL";
  const applyExpression = (expr: Expression, opts?: { banner?: boolean }) => {
    currentExpression = expr;
    try {
      scene.setExpression(expr);
    } catch {}
    if (btnExpression) {
      btnExpression.textContent = expressionIcons[expr] ?? "🙂";
      if (expr !== "NEUTRAL") btnExpression.dataset.active = "1";
      else delete btnExpression.dataset.active;
    }
    if (opts?.banner) {
      showBanner(`表情：${expressionLabels[expr] ?? expr}`, { timeoutMs: 1200 });
    }
  };
  applyExpression(currentExpression);

  const handlePetControl = async (msg: PetControlMessage) => {
    if (!msg || msg.type !== "PET_CONTROL") return;
    try {
      if (msg.action === "LOAD_VRM_BYTES") {
        if (vrmLocked) {
          sendPetStatus("info", "模型已锁定：忽略 VRM 切换请求。");
          sendPetControlResult(msg.requestId, false, "VRM 已锁定，无法切换模型");
          return;
        }
        setBootStatus("正在从控制台加载 VRM…");
        await scene.loadVrmBytes(msg.bytes);
        hudState.vrmLoaded = msg.bytes.byteLength > 0;
        scene.setCameraPreset?.("full"); // Apply full body preset on console load
        renderHud();
        sendPetState();
        if (hudState.vrmLoaded) void dismissBootOverlay();
        sendPetStatus("info", hudState.vrmLoaded ? "已加载 VRM ✅" : "未选择文件（已保留占位球体）");
        sendPetControlResult(msg.requestId, true);
        return;
      }

      if (msg.action === "LOAD_VRMA_BYTES") {
        // Avoid noisy boot status updates when Controls triggers a VRMA load.
        const res = await scene.loadVrmAnimationBytes(msg.bytes);
        const ok = res.ok;
        hudState.vrmaLoaded = ok;
        renderHud();
        sendPetState();
        sendPetStatus("info", ok ? "已加载 VRM 动作 ✅（可设为 Idle/Walk）" : "动作文件不兼容/解析失败（请换一个 .vrma）");
        sendPetControlResult(msg.requestId, ok, ok ? undefined : "动作文件不兼容/解析失败", res.durationMs !== undefined ? { durationMs: res.durationMs } : undefined);
        return;
      }

      if (msg.action === "SET_MODEL_TRANSFORM") {
        scene.setModelTransform(msg.transform as any);
        sendPetState();
        return;
      }

      if (msg.action === "REFIT_CAMERA") {
        scene.refitCamera();
        const t = scene.getModelTransform();
        persistModelTransform({ offsetX: t.offsetX, offsetY: t.offsetY, offsetZ: t.offsetZ });
        sendPetStatus("info", "已重置视角");
        return;
      }

      if (msg.action === "SPEAK") {
        scene.speak(900);
        return;
      }

      if (msg.action === "SPEAK_STOP") {
        stopTts();
        return;
      }

      if (msg.action === "SPEAK_TEXT") {
        await speakText((msg as any).text, (msg as any).options);
        return;
      }

      if (msg.action === "SET_IDLE_CONFIG") {
        scene.setIdleConfig(msg.config as any);
        return;
      }

      if (msg.action === "SET_WALK_CONFIG") {
        scene.setWalkConfig(msg.config as any);
        return;
      }

      if (msg.action === "SET_VRMA_CONFIG") {
        scene.setVrmAnimationConfig(msg.config as any);
        return;
      }

      if (msg.action === "CLEAR_VRMA_ACTION") {
        scene.clearVrmAnimation();
        sendPetState();
        return;
      }

      if (msg.action === "ASSIGN_VRMA_SLOT_FROM_LAST") {
        const ok = scene.setVrmAnimationSlotFromLast(msg.slot);
        sendPetState();
        sendPetStatus("info", ok ? `已设为 ${msg.slot.toUpperCase()}（自动切换）` : "请先加载一个 .vrma 动作文件");
        return;
      }

      if (msg.action === "CLEAR_VRMA_SLOT") {
        scene.clearVrmAnimationSlot(msg.slot);
        sendPetState();
        sendPetStatus("info", `已清除 ${msg.slot.toUpperCase()} 槽位`);
        return;
      }

      if (msg.action === "NOTIFY_ACTION") {
        scene.notifyAction(msg.cmd);
        applyExpression(msg.cmd.expression);
        if (msg.cmd.bubbleKind === "thinking") {
          if (isCaptionOverlayAlive()) hideInlineBubble();
          startCaptionAnchorTracking(msg.cmd.durationMs || 25_000);
        } else if (msg.cmd.bubble) {
          scene.speak(msg.cmd.durationMs);
          const a = scene.getBubbleAnchor?.();
          if (a) setInlineBubbleAnchor(a);

          // Caption overlay is the primary bubble surface; inline bubble is only a fallback.
          if (isCaptionOverlayAlive()) {
            hideInlineBubble();
          } else {
            showInlineBubble(msg.cmd.bubble, msg.cmd.durationMs || 3000);
          }
          startCaptionAnchorTracking(msg.cmd.durationMs);
        }
        sendPetState();
        return;
      }

      if (msg.action === "SET_CAMERA_PRESET") {
        scene.setCameraPreset?.((msg as any).preset);
        sendPetStatus("info", `相机切换至：${(msg as any).preset}`);
        return;
      }

      if (msg.action === "TAKE_SCREENSHOT") {
        const dataUrl = scene.takeScreenshot?.();
        if (dataUrl) {
          sendPetControlResult((msg as any).requestId, true, dataUrl);
        } else {
          sendPetControlResult((msg as any).requestId, false, "截图失败");
        }
        return;
      }

      if (msg.action === "SET_FRAME_CONFIG") {
        applyFrameConfig((msg as any).config ?? {});
        return;
      }
    } catch (err) {
      const message = formatErr(err);
      sendPetStatus("error", `控制台操作失败：${message}`);
      sendPetControlResult((msg as any).requestId, false, message);
    }
  };

  // Install the full handler and drain any queued controls in-order.
  handlePetControlReady = (msg: PetControlMessage) => {
    petControlDrain = petControlDrain
      .then(() => handlePetControl(msg))
      .catch((err) => console.warn("pet control error:", err));
  };
  for (const msg of pendingPetControls.splice(0)) handlePetControlReady(msg);

  // Load initial VRM (non-blocking): read from VRM_PATH / last-picked path via main, if any.
  // Avoid blocking UI/drag handlers while a file picker is open.
      void (async () => {
        try {
          setBootStatus("正在读取 VRM_PATH / 上次选择的模型…（也可点“选择 VRM…”）");
          const vrmBytes = await pickVrmBytes();
          await scene.loadVrmBytes(vrmBytes);
          hudState.vrmLoaded = vrmBytes.byteLength > 0;
          scene.setCameraPreset?.("full");
          renderHud();
          sendPetState();
          if (vrmBytes.byteLength) void dismissBootOverlay();
          sendPetStatus("info", hudState.vrmLoaded ? "已加载 VRM ✅" : "未配置模型：请点“选择 VRM…”或拖拽 .vrm");

          if (!vrmBytes.byteLength) {
            setBootStatus("未配置 VRM：点“选择 VRM…”或拖拽 .vrm 到窗口");
      }
    } catch (err) {
      setBootStatus(`VRM 加载失败：${formatErr(err)}`);
      hudState.vrmLoaded = false;
      renderHud();
      sendPetState();
      sendPetStatus("error", `VRM 加载失败：${formatErr(err)}`);
    }
  })();

  // Drag & drop import (works even without preload IPC)
  let dragDepth = 0;
  const isFileDrag = (e: DragEvent) => {
    const types = Array.from(e.dataTransfer?.types ?? []);
    return types.includes("Files");
  };
  const onDragEnter = (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    dragDepth += 1;
    setDropOverlayActive(true);
  };
  const onDragOver = (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
  };
  const onDragLeave = (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDropOverlayActive(false);
  };

  const onDrop = async (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    setDropOverlayActive(false);

    const file = e.dataTransfer?.files?.[0];
    if (!file) return;

    const name = (file.name || "").toLowerCase();
    if (!name.endsWith(".vrm") && !name.endsWith(".vrma")) {
      setBootStatus("只支持拖拽导入 .vrm 或 .vrma 文件");
      return;
    }

    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (name.endsWith(".vrm")) {
        if (vrmLocked) {
          setBootStatus("模型已锁定：忽略拖拽导入 VRM。你仍可拖拽导入 VRMA 动作。");
          return;
        }
        setBootStatus(`正在导入 VRM：${file.name}`);
        await scene.loadVrmBytes(bytes);
        hudState.vrmLoaded = bytes.byteLength > 0;
        sendPetState();
        if (bytes.byteLength) void dismissBootOverlay();
        sendPetStatus("info", "已加载 VRM ✅");
      } else {
        setBootStatus(`正在导入动作（VRMA）：${file.name}`);
        const res = await scene.loadVrmAnimationBytes(bytes);
        const ok = res.ok;
        hudState.vrmaLoaded = ok;
        sendPetState();
        sendPetStatus("info", ok ? "已加载 VRM 动作 ✅（可设为 Idle/Walk）" : "动作文件不兼容/解析失败（请换一个 .vrma）");
      }
      renderHud();
      setBootStatus(name.endsWith(".vrm") || hudState.vrmaLoaded ? "导入完成 ✅" : "动作文件不兼容/解析失败（请换一个 .vrma）");
    } catch (err) {
      setBootStatus(`导入失败：${formatErr(err)}`);
      sendPetStatus("error", `导入失败：${formatErr(err)}`);
    }
  };

  document.addEventListener("dragenter", onDragEnter);
  document.addEventListener("dragover", onDragOver);
  document.addEventListener("dragleave", onDragLeave);
  document.addEventListener("drop", onDrop);

  attachPetInteractions(canvas, {
    onClick: () => {
      (window as any).stageDesktop?.sendUserInteraction?.({
        type: "USER_INTERACTION",
        ts: Date.now(),
        event: "CLICK_PET"
      });
    },
    onDragDelta: (dx, dy) => {
      scene.notifyDragDelta(dx, dy);
      hudState.lastDrag = { dx: Math.round(dx), dy: Math.round(dy), at: Date.now() };
      scheduleRenderHud();

      const api: any = (window as any).stageDesktop;
      if (!api || typeof api.sendDragDelta !== "function") {
        // Avoid spamming when the user keeps dragging.
        const now = Date.now();
        const last = Number(hudState.lastNoIpcWarnAt) || 0;
        if (now - last > 1200) {
          hudState.lastNoIpcWarnAt = now;
          setBootStatus("窗口拖拽需要 preload IPC（或使用右上角“拖动窗口”按钮区域）。");
        }
        return;
      }
      queueDragDelta(dx, dy);
    },
    onOrbitDelta: (dx, dy) => {
      scene.orbitView?.(dx, dy);
    },
    onPanDelta: (dx, dy) => {
      scene.panModel?.(dx, dy);
      schedulePersist();
    },
    onDragState: (dragging) => scene.setDragging(dragging)
  });

  (window as any).stageDesktop?.onActionCommand?.((cmd: ActionCommand) => {
    scene.notifyAction(cmd);
    applyExpression(cmd.expression);
    if (cmd.bubbleKind === "thinking") {
      if (isCaptionOverlayAlive()) hideInlineBubble();
      startCaptionAnchorTracking(cmd.durationMs || 25_000);
    } else if (cmd.bubble) {
      scene.speak(cmd.durationMs);
      const a = scene.getBubbleAnchor?.();
      if (a) setInlineBubbleAnchor(a);

      if (isCaptionOverlayAlive()) {
        hideInlineBubble();
      } else {
        showInlineBubble(cmd.bubble, cmd.durationMs || 3000);
      }
      startCaptionAnchorTracking(cmd.durationMs);
    }

    // Help the caption window recover from preload issues by broadcasting actions in renderer space.
    // The caption renderer will only consume these messages when its preload API is missing.
    try {
      bc?.postMessage(cmd);
    } catch {}
  });

  (window as any).stageDesktop?.onClickThroughChanged?.((enabled: boolean) => {
    hudState.clickThrough = Boolean(enabled);
    renderHud();
  });

  renderHud();
  setBootStatus(
    vrmLocked
      ? "模型已锁定：仅支持导入 VRMA 动作；右键拖动旋转视角；Shift+左键拖动移动角色"
      : "拖拽导入：把 .vrm / .vrma 拖到窗口；右键拖动旋转视角；Shift+左键拖动移动角色"
  );
  sendPetState();

  // Boot screen (empty state) is now always visible until VRM loads.
  // if (bootRoot) {
  //   const dismissed = window.localStorage.getItem("sama.pet.boot.dismissed") === "1";
  //   if (dismissed) bootRoot.setAttribute("data-hidden", "1");
  // }
  if (bootClose && bootRoot) {
    bootClose.addEventListener("click", () => {
      bootRoot.setAttribute("data-hidden", "1");
      try {
        window.localStorage.setItem("sama.pet.boot.dismissed", "1");
      } catch {}
      showBanner("提示已隐藏（可随时用面板按钮/拖拽导入继续操作）", { timeoutMs: 1800 });
    });
  }

  if (bootPick) {
    bootPick.addEventListener("click", async () => {
      try {
        if (vrmLocked) {
          setBootStatus("模型已锁定：无法切换 VRM。");
          return;
        }
        setBootStatus("选择 VRM…");
        const api: any = (window as any).stageDesktop;
        const bytes =
          api && typeof api.pickVrmBytes === "function"
            ? await api.pickVrmBytes()
            : await pickBytesViaFileInput(".vrm");
        if (!bytes.byteLength) {
          setBootStatus("未选择文件（保持当前模型）");
          return;
        }
        await scene.loadVrmBytes(bytes);
        hudState.vrmLoaded = bytes.byteLength > 0;
        renderHud();
        setBootStatus("已加载 VRM ✅");
        sendPetState();
        if (bytes.byteLength) void dismissBootOverlay();
        sendPetStatus("info", "已加载 VRM ✅");
      } catch (err) {
        hudState.vrmLoaded = false;
        renderHud();
        setBootStatus(`选择/加载失败：${formatErr(err)}`);
        sendPetState();
        sendPetStatus("error", `选择/加载失败：${formatErr(err)}`);
      }
    });
  }

  if (bootPickAnim) {
    bootPickAnim.addEventListener("click", async () => {
      try {
        setBootStatus("选择 VRM 动作（.vrma）…");
        const bytes = await pickBytesViaFileInput(".vrma");
        if (!bytes.byteLength) {
          setBootStatus("未选择动作文件（保持当前动作）");
          return;
        }
        const res = await scene.loadVrmAnimationBytes(bytes);
        const ok = res.ok;
        hudState.vrmaLoaded = ok;
        renderHud();
        setBootStatus(ok ? "已加载 VRM 动作 ✅" : "动作文件不兼容/解析失败（请换一个 .vrma）");
        sendPetState();
        sendPetStatus("info", ok ? "已加载 VRM 动作 ✅（可设为 Idle/Walk）" : "动作文件不兼容/解析失败（请换一个 .vrma）");
      } catch (err) {
        hudState.vrmaLoaded = false;
        renderHud();
        setBootStatus(`动作加载失败：${formatErr(err)}`);
        sendPetState();
        sendPetStatus("error", `动作加载失败：${formatErr(err)}`);
      }
    });
  }

  // Quick action buttons
  const cameraPresets: Array<"full" | "half" | "closeup"> = ["full", "half", "closeup"];
  let currentPresetIdx = 0;

  if (btnCameraPreset) {
    btnCameraPreset.addEventListener("click", () => {
      currentPresetIdx = (currentPresetIdx + 1) % cameraPresets.length;
      const preset = cameraPresets[currentPresetIdx]!;
      scene.setCameraPreset?.(preset);
      const labels: Record<string, string> = { full: "全身", half: "半身", closeup: "特写" };
      const icons: Record<string, string> = { full: "👤", half: "👕", closeup: "😊" };
      btnCameraPreset.textContent = icons[preset] ?? "👤";
      showBanner(`视角：${labels[preset] ?? preset}`, { timeoutMs: 1200 });
    });
  }

  if (btnDragMove) {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const setActive = (active: boolean) => {
      if (!btnDragMove) return;
      if (active) btnDragMove.dataset.active = "1";
      else delete btnDragMove.dataset.active;
    };

    const endDrag = (e?: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      setActive(false);
      scene.setDragging(false);
      try {
        if (e) btnDragMove.releasePointerCapture(e.pointerId);
      } catch {}
    };

    btnDragMove.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const api: any = (window as any).stageDesktop;
      if (!api || typeof api.sendDragDelta !== "function") {
        showBanner("窗口拖拽需要 preload IPC（也可以直接在画布上拖动）", { timeoutMs: 2200 });
        return;
      }
      dragging = true;
      lastX = e.screenX;
      lastY = e.screenY;
      setActive(true);
      scene.setDragging(true);
      try {
        btnDragMove.setPointerCapture(e.pointerId);
      } catch {}
      e.preventDefault();
    });

    btnDragMove.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.screenX - lastX;
      const dy = e.screenY - lastY;
      lastX = e.screenX;
      lastY = e.screenY;
      if (!dx && !dy) return;

      scene.notifyDragDelta(dx, dy);
      hudState.lastDrag = { dx: Math.round(dx), dy: Math.round(dy), at: Date.now() };
      scheduleRenderHud();

      const api: any = (window as any).stageDesktop;
      try {
        if (api && typeof api.sendDragDelta === "function") queueDragDelta(dx, dy);
      } catch {}
    });

    btnDragMove.addEventListener("pointerup", (e) => endDrag(e));
    btnDragMove.addEventListener("pointercancel", (e) => endDrag(e));
    btnDragMove.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  if (btnMotion) {
    const pending = new Map<string, { resolve: (r: PetControlResult) => void; reject: (e: unknown) => void }>();
    let installed = false;

    const createReqId = () => `req_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;

    const ensureListener = () => {
      if (installed) return;
      const api: any = (window as any).stageDesktop;
      if (!api || typeof api.onPetControlResult !== "function") return;
      installed = true;
      api.onPetControlResult((res: PetControlResult) => {
        const p = pending.get(res.requestId);
        if (!p) return;
        pending.delete(res.requestId);
        p.resolve(res);
      });
    };

    const sendWithResult = (msg: PetControlMessage, opts?: { timeoutMs?: number }) => {
      ensureListener();
      const api: any = (window as any).stageDesktop;
      if (!api || typeof api.sendPetControl !== "function") {
        return Promise.reject(new Error("preload API missing"));
      }

      const timeoutMs = Math.max(800, Math.min(30_000, Math.floor(Number(opts?.timeoutMs ?? 12_000))));
      const requestId = String((msg as any).requestId ?? "").trim() || createReqId();
      (msg as any).requestId = requestId;

      return new Promise<PetControlResult>((resolve, reject) => {
        try {
          api.sendPetControl(msg);
        } catch (err) {
          reject(err);
          return;
        }

        let timer: number | null = null;
        const done = (fn: (v: any) => void, v: any) => {
          if (timer !== null) window.clearTimeout(timer);
          pending.delete(requestId);
          fn(v);
        };

        pending.set(requestId, { resolve: (r) => done(resolve, r), reject: (e) => done(reject, e) });
        timer = window.setTimeout(() => done(reject, new Error("timeout")), timeoutMs);
      });
    };

    const playIdleNatural = async () => {
      try {
        const res = await sendWithResult(
          { type: "PET_CONTROL", ts: Date.now(), action: "PLAY_MOTION_PRESET", presetId: "idle_natural" } as any,
          { timeoutMs: 2500 }
        );
        if (!res.ok) throw new Error(String(res.message ?? "failed"));
        showBanner("自然待机", { timeoutMs: 1200 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showBanner(`重置失败：${msg}`, { timeoutMs: 2500 });
      }
    };

    const cycleNext = async () => {
      try {
        const res = await sendWithResult({ type: "PET_CONTROL", ts: Date.now(), action: "CYCLE_MOTION_PRESET" } as any);
        if (!res.ok) throw new Error(String(res.message ?? "failed"));
        const name = String(res.message ?? "").trim();
        showBanner(name ? `动作：${name}` : "动作已切换", { timeoutMs: 1400 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Fallback: at least reset locally so the button still "does something" even if IPC breaks.
        try {
          scene.clearVrmAnimation();
        } catch {}
        showBanner(`切换失败：${msg}`, { timeoutMs: 2600 });
      }
    };

    // Short click: cycle presets. Long press (or right click): reset to natural idle.
    let longPressTimer: number | null = null;
    let longPressed = false;
    const cancelLongPress = () => {
      if (longPressTimer !== null) window.clearTimeout(longPressTimer);
      longPressTimer = null;
    };

    btnMotion.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      longPressed = false;
      cancelLongPress();
      longPressTimer = window.setTimeout(() => {
        longPressed = true;
        void playIdleNatural();
      }, 520);
    });
    btnMotion.addEventListener("pointerup", (e) => {
      if (e.button !== 0) return;
      cancelLongPress();
      if (longPressed) return;
      void cycleNext();
    });
    btnMotion.addEventListener("pointercancel", cancelLongPress);
    btnMotion.addEventListener("pointerleave", cancelLongPress);
    btnMotion.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      cancelLongPress();
      void playIdleNatural();
    });
  }

  if (btnExpression) {
    const reset = () => applyExpression("NEUTRAL", { banner: true });
    const cycleNext = () => {
      const idx = expressionOrder.indexOf(currentExpression);
      const next = expressionOrder[(idx >= 0 ? idx + 1 : 0) % expressionOrder.length] ?? "NEUTRAL";
      applyExpression(next, { banner: true });
    };

    // Short click: cycle expressions. Long press (or right click): reset to neutral.
    let longPressTimer: number | null = null;
    let longPressed = false;
    const cancelLongPress = () => {
      if (longPressTimer !== null) window.clearTimeout(longPressTimer);
      longPressTimer = null;
    };

    btnExpression.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      longPressed = false;
      cancelLongPress();
      longPressTimer = window.setTimeout(() => {
        longPressed = true;
        reset();
      }, 520);
    });
    btnExpression.addEventListener("pointerup", (e) => {
      if (e.button !== 0) return;
      cancelLongPress();
      if (longPressed) return;
      cycleNext();
    });
    btnExpression.addEventListener("pointercancel", cancelLongPress);
    btnExpression.addEventListener("pointerleave", cancelLongPress);
    btnExpression.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      cancelLongPress();
      reset();
    });
  }

  if (btnOpenChat) {
    btnOpenChat.addEventListener("click", () => {
      const api: any = (window as any).stageDesktop;
      if (api && typeof api.openControlsWindow === "function") {
        showBanner("正在打开控制台...", { timeoutMs: 1500 });
        try {
          // The API might be async (it invokes IPC), so we should handle potential rejections.
          Promise.resolve(api.openControlsWindow())
            .then((res: any) => {
              if (res && typeof res === "object" && res.ok === false) {
                const msg = String(res.message ?? "").trim() || "unknown error";
                showBanner(`打开失败: ${msg}`, { timeoutMs: 3200 });
                return;
              }
              showBanner("控制台已打开", { timeoutMs: 1100 });
            })
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              console.error("Failed to open controls:", err);
              showBanner(`打开失败: ${msg}`, { timeoutMs: 3000 });
            });
        } catch (err) {
           const msg = err instanceof Error ? err.message : String(err);
           showBanner(`调用错误: ${msg}`, { timeoutMs: 3000 });
        }
      } else {
        showBanner("无法打开控制台 (API missing)", { timeoutMs: 1500 });
      }
    });
  }
}

void boot().catch((err) => {
  setHud(`boot error: ${formatErr(err)}`);
  setBootStatus(`启动失败：${formatErr(err)}`);
});
