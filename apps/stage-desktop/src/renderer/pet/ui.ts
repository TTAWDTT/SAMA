export function attachPetInteractions(
  canvas: HTMLCanvasElement,
  opts: {
    onClick: () => void;
    /** Drag pet window (main process). */
    onDragDelta: (dx: number, dy: number) => void;
    onDragState?: (v: boolean) => void;
    /** Rotate view (right button drag). */
    onOrbitDelta?: (dx: number, dy: number) => void;
    /** Move model inside the window (Shift + left drag). */
    onPanDelta?: (dx: number, dy: number) => void;
  }
) {
  type DragMode = "window" | "pan" | "orbit" | "none";

  let dragging = false;
  let mode: DragMode = "none";
  let moved = 0;
  let lastX = 0;
  let lastY = 0;

  const onPointerDown = (e: PointerEvent) => {
    // left=0, right=2
    if (e.button === 2) {
      mode = "orbit";
      // prevent context menu while orbiting
      e.preventDefault();
    } else if (e.button === 0 && e.shiftKey) {
      mode = "pan";
    } else if (e.button === 0) {
      mode = "window";
    } else {
      mode = "none";
      return;
    }

    dragging = true;
    moved = 0;
    lastX = e.screenX;
    lastY = e.screenY;
    canvas.setPointerCapture(e.pointerId);
    if (mode === "window") opts.onDragState?.(true);

    if (mode === "orbit") canvas.style.cursor = "grabbing";
    if (mode === "pan") canvas.style.cursor = "move";
    if (mode === "window") canvas.style.cursor = "grabbing";
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    const dx = e.screenX - lastX;
    const dy = e.screenY - lastY;
    lastX = e.screenX;
    lastY = e.screenY;
    moved += Math.abs(dx) + Math.abs(dy);
    if (!dx && !dy) return;
    if (mode === "window") opts.onDragDelta(dx, dy);
    if (mode === "pan") opts.onPanDelta?.(dx, dy);
    if (mode === "orbit") opts.onOrbitDelta?.(dx, dy);
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    canvas.releasePointerCapture(e.pointerId);
    if (mode === "window") {
      opts.onDragState?.(false);
      if (moved < 6) opts.onClick();
    }
    mode = "none";
    canvas.style.cursor = "grab";
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);

  const onContextMenu = (e: MouseEvent) => e.preventDefault();
  canvas.addEventListener("contextmenu", onContextMenu);

  return () => {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    canvas.removeEventListener("contextmenu", onContextMenu);
  };
}
