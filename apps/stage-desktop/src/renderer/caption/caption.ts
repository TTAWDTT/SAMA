import type { ActionCommand } from "@sama/shared";

export function createCaptionController(el: HTMLDivElement) {
  let hideTimer: number | null = null;
  let anchor = { nx: 0.5, ny: 0.22 };
  let visible = false;

  function clamp01(n: number) {
    return Math.max(0, Math.min(1, n));
  }

  function clamp(n: number, min: number, max: number) {
    return Math.max(min, Math.min(max, n));
  }

  function layout() {
    const vw = Math.max(1, window.innerWidth || 1);
    const vh = Math.max(1, window.innerHeight || 1);

    const rect = el.getBoundingClientRect();
    const bw = Math.max(1, rect.width || el.offsetWidth || 1);
    const bh = Math.max(1, rect.height || el.offsetHeight || 1);

    const margin = 14;
    const gap = 12;

    const anchorX = clamp(anchor.nx, 0, 1) * vw;
    const anchorY = clamp(anchor.ny, 0, 1) * vh;

    // Decide whether the bubble should appear above or below the anchor point.
    // Default: above; if too close to the top edge, flip to below.
    let placement: "top" | "bottom" = "top";
    if (anchorY < bh + margin + gap) placement = "bottom";
    if (anchorY > vh - bh - margin - gap) placement = "top";

    // Clamp x so the bubble stays fully within view (centered around x).
    const x = clamp(anchorX, margin + bw / 2, vw - margin - bw / 2);

    // For placement:
    // - top: bubble's bottom is near the anchor (translateY(-100%))
    // - bottom: bubble's top is near the anchor (translateY(0))
    const y =
      placement === "top"
        ? clamp(anchorY, bh + margin + gap, vh - margin)
        : clamp(anchorY, margin, vh - bh - margin - gap);

    el.dataset.placement = placement;
    el.style.setProperty("--bx", `${x.toFixed(2)}px`);
    el.style.setProperty("--by", `${y.toFixed(2)}px`);
  }

  function hide() {
    el.classList.remove("show");
    el.textContent = "";
    visible = false;
  }

  function show(text: string) {
    el.textContent = text;
    el.classList.add("show");
    visible = true;
    // Layout after DOM updates so we can measure bubble size.
    requestAnimationFrame(() => {
      layout();
    });
  }

  function scheduleHide(durationMs: number) {
    if (hideTimer) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      hide();
    }, Math.max(50, durationMs));
  }

  window.addEventListener("resize", () => {
    if (!visible) return;
    layout();
  });

  return {
    setAnchor: (a: { nx: number; ny: number }) => {
      const nx = clamp01(Number(a?.nx ?? 0.5));
      const ny = clamp01(Number(a?.ny ?? 0.22));
      anchor = { nx, ny };
      if (visible) layout();
    },
    onCommand: (cmd: ActionCommand) => {
      if (!cmd.bubble) return;
      show(cmd.bubble);
      scheduleHide(cmd.durationMs || 3000);
    }
  };
}
