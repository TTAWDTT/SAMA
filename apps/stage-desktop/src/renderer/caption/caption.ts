import type { ActionCommand } from "@sama/shared";

export function createCaptionController(el: HTMLDivElement) {
  let hideTimer: number | null = null;
  let anchor = { nx: 0.5, ny: 0.22 };

  function clamp01(n: number) {
    return Math.max(0, Math.min(1, n));
  }

  function applyAnchor() {
    el.style.left = `${(anchor.nx * 100).toFixed(3)}%`;
    el.style.top = `${(anchor.ny * 100).toFixed(3)}%`;
  }

  function hide() {
    el.classList.remove("show");
    el.textContent = "";
  }

  function show(text: string) {
    el.textContent = text;
    el.classList.add("show");
    applyAnchor();
  }

  function scheduleHide(durationMs: number) {
    if (hideTimer) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      hide();
    }, Math.max(50, durationMs));
  }

  return {
    setAnchor: (a: { nx: number; ny: number }) => {
      const nx = clamp01(Number(a?.nx ?? 0.5));
      const ny = clamp01(Number(a?.ny ?? 0.22));
      anchor = { nx, ny };
      applyAnchor();
    },
    onCommand: (cmd: ActionCommand) => {
      if (!cmd.bubble) return;
      show(cmd.bubble);
      scheduleHide(cmd.durationMs || 3000);
    }
  };
}
