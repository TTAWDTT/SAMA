import type { ActionCommand } from "@sama/shared";
import { createCaptionController } from "./caption";

const bubble = document.getElementById("bubble") as HTMLDivElement | null;
if (!bubble) throw new Error("missing #bubble");

const caption = createCaptionController(bubble);

const BC_NAME = "sama:pet-bus";
const bc = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(BC_NAME) : null;

if (bc) {
  bc.addEventListener("message", (evt: MessageEvent) => {
    const msg: any = (evt as any).data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type !== "CAPTION_ANCHOR") return;
    const nx = Number(msg.nx);
    const ny = Number(msg.ny);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
    caption.setAnchor({ nx, ny });
  });

  window.addEventListener("beforeunload", () => {
    try {
      bc.close();
    } catch {}
  });
}

window.stageDesktop.onActionCommand((cmd: ActionCommand) => {
  caption.onCommand(cmd);
});
