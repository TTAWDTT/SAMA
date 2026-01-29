import type { ActionCommand } from "@sama/shared";
import { createCaptionController } from "./caption";

const bubble = document.getElementById("bubble") as HTMLDivElement | null;
if (!bubble) throw new Error("missing #bubble");

const caption = createCaptionController(bubble);

const BC_NAME = "sama:pet-bus";
const bc = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(BC_NAME) : null;

const api: any = (window as any).stageDesktop;
const hasApi = Boolean(api && typeof api.onActionCommand === "function");

if (hasApi) {
  api.onActionCommand((cmd: ActionCommand) => {
    caption.onCommand(cmd);
  });
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
