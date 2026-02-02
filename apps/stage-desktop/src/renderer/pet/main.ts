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
const btnMotionEl = document.getElementById("btnMotion");
const btnMotion = btnMotionEl instanceof HTMLButtonElement ? btnMotionEl : null;
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

function sendPetControlResult(requestId: string | undefined, ok: boolean, message?: string) {
  if (!requestId) return;
  const payload: PetControlResult = { type: "PET_CONTROL_RESULT", ts: Date.now(), requestId, ok, message };
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

  setBootStatus("正在启动渲染…（可稍后用“选择 VRM…”或拖拽导入）");

  const scene = await createPetScene(canvas, new Uint8Array());
  // Start rendering immediately so the window is not fully transparent while waiting for file pick / IPC.
  setHud("render: running");
  scene.start();

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
  const postCaptionAnchor = () => {
    const a = scene.getBubbleAnchor?.();
    if (!a) return;
    if (inlineBubbleVisible) setInlineBubbleAnchor(a);
    try {
      bc?.postMessage({ type: "CAPTION_ANCHOR", ts: Date.now(), nx: a.nx, ny: a.ny });
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
    }, 80);
  };

  const sendPetState = () => {
    const payload: PetStateMessage = {
      type: "PET_STATE",
      ts: Date.now(),
      vrmLoaded: Boolean(hudState.vrmLoaded),
      motion: scene.getMotionState(),
      slots: scene.getVrmAnimationSlotsStatus()
    };
    try {
      (window as any).stageDesktop?.sendPetState?.(payload);
    } catch {}
    try {
      bc?.postMessage(payload);
    } catch {}
  };

  // Keep the Controls window updated (even if it opens later).
  const petStateTimer = window.setInterval(sendPetState, 250);
  window.addEventListener("beforeunload", () => {
    window.clearInterval(petStateTimer);
    if (persistTimer !== null) window.clearTimeout(persistTimer);
    if (anchorTimer !== null) window.clearInterval(anchorTimer);
    try {
      bc?.close();
    } catch {}
  });

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
        renderHud();
        sendPetState();
        if (hudState.vrmLoaded) bootRoot?.setAttribute("data-hidden", "1");
        sendPetStatus("info", hudState.vrmLoaded ? "已加载 VRM ✅" : "未选择文件（已保留占位球体）");
        sendPetControlResult(msg.requestId, true);
        return;
      }

      if (msg.action === "LOAD_VRMA_BYTES") {
        // Avoid noisy boot status updates when Controls triggers a VRMA load.
        const ok = await scene.loadVrmAnimationBytes(msg.bytes);
        hudState.vrmaLoaded = ok;
        renderHud();
        sendPetState();
        sendPetStatus("info", ok ? "已加载 VRM 动作 ✅（可设为 Idle/Walk）" : "动作文件不兼容/解析失败（请换一个 .vrma）");
        sendPetControlResult(msg.requestId, ok, ok ? undefined : "动作文件不兼容/解析失败");
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
        scene.setExpression(msg.cmd.expression);
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
        const cfg: any = (msg as any).config ?? {};
        if (hoverFrame) {
          // Only toggle enabled class when explicitly set (not undefined)
          if (cfg.enabled === true) {
            hoverFrame.classList.add("enabled");
          } else if (cfg.enabled === false) {
            hoverFrame.classList.remove("enabled");
            hoverFrame.classList.remove("previewing");
          }

          // Apply style settings if frame is enabled
          if (hoverFrame.classList.contains("enabled")) {
            if (typeof cfg.size === "number") {
              hoverFrame.style.borderWidth = `${cfg.size}px`;
            }
            if (typeof cfg.radius === "number") {
              hoverFrame.style.borderRadius = `${cfg.radius}px`;
            }
            if (typeof cfg.color === "string") {
              hoverFrame.style.borderColor = cfg.color;
            }
            // Show frame while adjusting settings (previewing mode)
            if (cfg.previewing === true) {
              hoverFrame.classList.add("previewing");
            } else if (cfg.previewing === false) {
              hoverFrame.classList.remove("previewing");
            }
          }
        }
        return;
      }
    } catch (err) {
      const message = formatErr(err);
      sendPetStatus("error", `控制台操作失败：${message}`);
      sendPetControlResult((msg as any).requestId, false, message);
    }
  };

  // Apply control commands coming from the separate Controls window (via preload IPC).
  (window as any).stageDesktop?.onPetControl?.((msg: PetControlMessage) => void handlePetControl(msg));

  // Fallback: when preload IPC is missing/broken, allow Controls -> Pet commands via BroadcastChannel.
  if (bc) {
    const bcHandler = (evt: MessageEvent) => {
      const msg: any = (evt as any).data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "CAPTION_READY") {
        lastCaptionReadyAt = Date.now();
        return;
      }
      if (msg.type !== "PET_CONTROL") return;
      void handlePetControl(msg as PetControlMessage);
    };
    bc.addEventListener("message", bcHandler);
  }

  // Load initial VRM (non-blocking): read from VRM_PATH / last-picked path via main, if any.
  // Avoid blocking UI/drag handlers while a file picker is open.
  void (async () => {
    try {
      setBootStatus("正在读取 VRM_PATH / 上次选择的模型…（也可点“选择 VRM…”）");
      const vrmBytes = await pickVrmBytes();
      await scene.loadVrmBytes(vrmBytes);
      hudState.vrmLoaded = vrmBytes.byteLength > 0;
      renderHud();
      if (vrmBytes.byteLength) bootRoot?.setAttribute("data-hidden", "1");
      sendPetState();
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
        if (bytes.byteLength) bootRoot?.setAttribute("data-hidden", "1");
        sendPetState();
        sendPetStatus("info", "已加载 VRM ✅");
      } else {
        setBootStatus(`正在导入动作（VRMA）：${file.name}`);
        const ok = await scene.loadVrmAnimationBytes(bytes);
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
      renderHud();

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
      api.sendDragDelta({ dx, dy });
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
    scene.setExpression(cmd.expression);
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

  if (bootRoot) {
    const dismissed = window.localStorage.getItem("sama.pet.boot.dismissed") === "1";
    if (dismissed) bootRoot.setAttribute("data-hidden", "1");
  }
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
        if (bytes.byteLength) bootRoot?.setAttribute("data-hidden", "1");
        sendPetState();
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
        const ok = await scene.loadVrmAnimationBytes(bytes);
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

  if (btnMotion) {
    btnMotion.addEventListener("click", () => {
      // Toggle between idle and action states
      scene.clearVrmAnimation();
      showBanner("动作已重置", { timeoutMs: 1200 });
    });
  }

  if (btnOpenChat) {
    btnOpenChat.addEventListener("click", () => {
      const api: any = (window as any).stageDesktop;
      if (api && typeof api.openControlsWindow === "function") {
        api.openControlsWindow();
        showBanner("打开控制台...", { timeoutMs: 1000 });
      } else {
        showBanner("无法打开聊天窗口", { timeoutMs: 1500 });
      }
    });
  }
}

void boot().catch((err) => {
  setHud(`boot error: ${formatErr(err)}`);
  setBootStatus(`启动失败：${formatErr(err)}`);
});
