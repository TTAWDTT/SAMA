import type { ActionCommand } from "@sama/shared";

export function createCaptionController(el: HTMLDivElement) {
  let hideTimer: number | null = null;

  function hide() {
    el.classList.remove("show");
    el.textContent = "";
  }

  function show(text: string) {
    el.textContent = text;
    el.classList.add("show");
  }

  function scheduleHide(durationMs: number) {
    if (hideTimer) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      hide();
    }, Math.max(50, durationMs));
  }

  return {
    onCommand: (cmd: ActionCommand) => {
      if (!cmd.bubble) return;
      show(cmd.bubble);
      scheduleHide(cmd.durationMs || 3000);
    }
  };
}
