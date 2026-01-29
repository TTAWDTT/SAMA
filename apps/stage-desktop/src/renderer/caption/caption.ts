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

  type Placement = "top" | "bottom" | "left" | "right";
  type ViewportRect = { x: number; y: number; width: number; height: number };

  // When the pet is in "peek" mode, the window can be partially off-screen.
  // We keep a "visible rect" (in window-local coords) so bubbles never render off-screen.
  let viewport: ViewportRect | null = null;
  let preferredPlacement: Placement | null = null;

  function getViewport(): ViewportRect {
    const winW = Math.max(1, window.innerWidth || 1);
    const winH = Math.max(1, window.innerHeight || 1);
    if (!viewport) return { x: 0, y: 0, width: winW, height: winH };

    const x = clamp(Number(viewport.x ?? 0), 0, winW - 1);
    const y = clamp(Number(viewport.y ?? 0), 0, winH - 1);
    const w = clamp(Number(viewport.width ?? winW), 1, winW - x);
    const h = clamp(Number(viewport.height ?? winH), 1, winH - y);
    return { x, y, width: w, height: h };
  }

  function layoutOne(el: HTMLDivElement, vars: { x: string; y: string }) {
    const winW = Math.max(1, window.innerWidth || 1);
    const winH = Math.max(1, window.innerHeight || 1);
    const view = getViewport();
    const viewLeft = view.x;
    const viewTop = view.y;
    const viewRight = view.x + view.width;
    const viewBottom = view.y + view.height;

    const rect = el.getBoundingClientRect();
    const bw = Math.max(1, rect.width || el.offsetWidth || 1);
    const bh = Math.max(1, rect.height || el.offsetHeight || 1);

    const margin = 14;
    // Keep bubble/thinking away from the head so we don't cover the avatar.
    const gap = 20;

    const anchorX = clamp(anchor.nx, 0, 1) * winW;
    const anchorY = clamp(anchor.ny, 0, 1) * winH;

    // Side placement is strongly preferred. We allow vertical clamping, so we only require enough
    // room on the X axis (same for top/bottom on Y axis).
    const canPlaceRight = anchorX + gap + bw <= viewRight - margin;
    const canPlaceLeft = anchorX - gap - bw >= viewLeft + margin;
    const canPlaceTop = anchorY - gap - bh >= viewTop + margin;
    const canPlaceBottom = anchorY + gap + bh <= viewBottom - margin;

    // Prefer side placement so the bubble/thinking sits next to the head, not on top of it.
    const order: Placement[] = [];
    if (preferredPlacement) order.push(preferredPlacement);
    (["right", "left", "top", "bottom"] as Placement[]).forEach((p) => {
      if (!order.includes(p)) order.push(p);
    });

    const ok = (p: Placement) => {
      if (p === "right") return canPlaceRight;
      if (p === "left") return canPlaceLeft;
      if (p === "top") return canPlaceTop;
      return canPlaceBottom;
    };

    let placement: Placement = order.find(ok) ?? (canPlaceRight ? "right" : canPlaceLeft ? "left" : canPlaceTop ? "top" : "bottom");

    let x = anchorX;
    let y = anchorY;
    if (placement === "top") {
      x = clamp(anchorX, viewLeft + margin + bw / 2, viewRight - margin - bw / 2);
      y = clamp(anchorY - gap, viewTop + margin + bh, viewBottom - margin);
    } else if (placement === "bottom") {
      x = clamp(anchorX, viewLeft + margin + bw / 2, viewRight - margin - bw / 2);
      y = clamp(anchorY + gap, viewTop + margin, viewBottom - margin - bh);
    } else if (placement === "right") {
      x = clamp(anchorX + gap, viewLeft + margin, viewRight - margin - bw);
      y = clamp(anchorY, viewTop + margin + bh / 2, viewBottom - margin - bh / 2);
    } else {
      // left
      x = clamp(anchorX - gap, viewLeft + margin + bw, viewRight - margin);
      y = clamp(anchorY, viewTop + margin + bh / 2, viewBottom - margin - bh / 2);
    }

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
    setViewport: (r: ViewportRect | null) => {
      viewport = r;
      layout();
    },
    setPreferredPlacement: (p: Placement | null) => {
      preferredPlacement = p;
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
