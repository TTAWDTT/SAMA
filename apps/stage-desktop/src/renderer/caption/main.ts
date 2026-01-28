import type { ActionCommand } from "@sama/shared";
import { createCaptionController } from "./caption";

const bubble = document.getElementById("bubble") as HTMLDivElement | null;
if (!bubble) throw new Error("missing #bubble");

const caption = createCaptionController(bubble);

window.stageDesktop.onActionCommand((cmd: ActionCommand) => {
  caption.onCommand(cmd);
});

