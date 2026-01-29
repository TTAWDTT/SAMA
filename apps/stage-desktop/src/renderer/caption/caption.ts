import type { ActionCommand } from "@sama/shared";

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

type Anchor = { nx: number; ny: number };

export function createCaptionController(opts: { bubbleEl: HTMLDivElement; thinkingEl: HTMLDivElement }) {
  const bubbleEl = opts.bubbleEl;
  const thinkingEl = opts.thinkingEl;

  let hideTimer: number | null = null;
  let anchor: Anchor = { nx: 0.5, ny: 0.22 };
  let bubbleVisible = false;
  let thinkingVisible = false;

  function layoutOne(el: HTMLDivElement, vars: { x: string; y: string }) {
    const vw = Math.max(1, window.innerWidth || 1);
    const vh = Math.max(1, window.innerHeight || 1);

    const rect = el.getBoundingClientRect();
    const bw = Math.max(1, rect.width || el.offsetWidth || 1);
    const bh = Math.max(1, rect.height || el.offsetHeight || 1);

    const margin = 14;
    const gap = 12;

    const anchorX = clamp(anchor.nx, 0, 1) * vw;
    const anchorY = clamp(anchor.ny, 0, 1) * vh;

    // Default: above; if too close to the top edge, flip to below.
    let placement: "top" | "bottom" = "top";
    if (anchorY < bh + margin + gap) placement = "bottom";
    if (anchorY > vh - bh - margin - gap) placement = "top";

    const x = clamp(anchorX, margin + bw / 2, vw - margin - bw / 2);
    const y =
      placement === "top"
        ? clamp(anchorY, bh + margin + gap, vh - margin)
        : clamp(anchorY, margin, vh - bh - margin - gap);

    el.dataset.placement = placement;
    el.style.setProperty(vars.x, `${x.toFixed(2)}px`);
    el.style.setProperty(vars.y, `${y.toFixed(2)}px`);
  }

  function layout() {
    if (bubbleVisible) layoutOne(bubbleEl, { x: "--bx", y: "--by" });
    if (thinkingVisible) layoutOne(thinkingEl, { x: "--tx", y: "--ty" });
  }

  function stopHideTimer() {
    if (hideTimer) window.clearTimeout(hideTimer);
    hideTimer = null;
  }

  function hideBubble() {
    bubbleEl.classList.remove("show");
    bubbleEl.textContent = "";
    bubbleVisible = false;
  }

  function hideThinking() {
    thinkingEl.classList.remove("show");
    thinkingVisible = false;
  }

  function showBubble(text: string) {
    hideThinking();
    stopHideTimer();

    bubbleEl.textContent = text;
    bubbleEl.classList.add("show");
    bubbleVisible = true;

    requestAnimationFrame(() => layout());
  }

  function showThinking(durationMs: number) {
    hideBubble();
    stopHideTimer();

    thinkingEl.classList.add("show");
    thinkingVisible = true;

    requestAnimationFrame(() => layout());

    // Safety valve: don't get stuck forever if something goes wrong.
    const ms = Math.max(800, Number(durationMs) || 0);
    hideTimer = window.setTimeout(() => {
      hideThinking();
      hideTimer = null;
    }, ms);
  }

  function scheduleHideBubble(durationMs: number) {
    stopHideTimer();
    const ms = Math.max(50, Number(durationMs) || 0);
    hideTimer = window.setTimeout(() => {
      hideBubble();
      hideTimer = null;
    }, ms);
  }

  window.addEventListener("resize", () => {
    if (!bubbleVisible && !thinkingVisible) return;
    layout();
  });

  return {
    setAnchor: (a: Anchor) => {
      anchor = { nx: clamp01(Number(a?.nx ?? 0.5)), ny: clamp01(Number(a?.ny ?? 0.22)) };
      layout();
    },
    onCommand: (cmd: ActionCommand) => {
      if (cmd.bubbleKind === "thinking") {
        showThinking(cmd.durationMs || 25_000);
        return;
      }

      // Normal text bubble
      if (cmd.bubble) {
        showBubble(cmd.bubble);
        scheduleHideBubble(cmd.durationMs || 3000);
        return;
      }
    }
  };
}

