import type { ActionCommand } from "@sama/shared";
import { createCaptionController } from "./caption";

const bubble = document.getElementById("bubble");
if (!(bubble instanceof HTMLDivElement)) throw new Error("missing #bubble");

const thinking = document.getElementById("thinking");
if (!(thinking instanceof HTMLDivElement)) throw new Error("missing #thinking");

const caption = createCaptionController({ bubbleEl: bubble, thinkingEl: thinking });

const BC_NAME = "sama:pet-bus";
const bc = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(BC_NAME) : null;

const api: any = (window as any).stageDesktop;
const hasApi = Boolean(api && typeof api.onActionCommand === "function");

if (hasApi) {
  api.onActionCommand((cmd: ActionCommand) => {
    caption.onCommand(cmd);
  });

  // Keep bubble placement inside the *visible* part of the window (peek mode can be partially off-screen).
  if (typeof api.onPetWindowState === "function") {
    api.onPetWindowState((s: any) => {
      const bounds = s?.bounds;
      const wa = s?.workArea;

      if (
        bounds &&
        wa &&
        Number.isFinite(bounds.x) &&
        Number.isFinite(bounds.y) &&
        Number.isFinite(bounds.width) &&
        Number.isFinite(bounds.height) &&
        Number.isFinite(wa.x) &&
        Number.isFinite(wa.y) &&
        Number.isFinite(wa.width) &&
        Number.isFinite(wa.height)
      ) {
        const left = Math.max(bounds.x, wa.x);
        const top = Math.max(bounds.y, wa.y);
        const right = Math.min(bounds.x + bounds.width, wa.x + wa.width);
        const bottom = Math.min(bounds.y + bounds.height, wa.y + wa.height);

        const w = Math.max(1, right - left);
        const h = Math.max(1, bottom - top);
        const vx = left - bounds.x;
        const vy = top - bounds.y;

        caption.setViewport({ x: vx, y: vy, width: w, height: h });
      } else {
        caption.setViewport(null);
      }

      const mode = s?.displayMode?.mode;
      const edge = s?.displayMode?.edge;
      if (mode === "peek") {
        const prefer =
          edge === "right" ? "left" : edge === "left" ? "right" : edge === "top" ? "bottom" : edge === "bottom" ? "top" : null;
        caption.setPreferredPlacement(prefer);
      } else {
        caption.setPreferredPlacement(null);
      }
    });
  }
}

if (bc) {
  const onMessage = (evt: MessageEvent) => {
    const msg: any = (evt as any).data;
    if (!msg || typeof msg !== "object") return;

    // Anchor updates (pet -> caption)
    if (msg.type === "CAPTION_ANCHOR") {
      const nx = Number(msg.nx);
      const ny = Number(msg.ny);
      if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
      caption.setAnchor({ nx, ny });
      return;
    }

    // Also accept ActionCommand via BroadcastChannel (more robust than relying on preload IPC only).
    if (msg.type === "ACTION_COMMAND") {
      caption.onCommand(msg as ActionCommand);
      return;
    }
  };

  bc.addEventListener("message", onMessage);

  // Let the pet window know the caption overlay is alive, so it can decide whether to draw an inline bubble fallback.
  const ping = () => {
    try {
      bc.postMessage({ type: "CAPTION_READY", ts: Date.now() });
    } catch {}
  };
  ping();
  const pingTimer = window.setInterval(ping, 2000);

  window.addEventListener("beforeunload", () => {
    window.clearInterval(pingTimer);
    try {
      bc.removeEventListener("message", onMessage);
    } catch {}
    try {
      bc.close();
    } catch {}
  });
}
