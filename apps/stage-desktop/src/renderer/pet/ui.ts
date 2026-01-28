export function attachPetInteractions(
  canvas: HTMLCanvasElement,
  opts: { onClick: () => void; onDragDelta: (dx: number, dy: number) => void; onDragState?: (v: boolean) => void }
) {
  let dragging = false;
  let moved = 0;
  let lastX = 0;
  let lastY = 0;

  const onPointerDown = (e: PointerEvent) => {
    dragging = true;
    moved = 0;
    lastX = e.screenX;
    lastY = e.screenY;
    canvas.setPointerCapture(e.pointerId);
    opts.onDragState?.(true);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    const dx = e.screenX - lastX;
    const dy = e.screenY - lastY;
    lastX = e.screenX;
    lastY = e.screenY;
    moved += Math.abs(dx) + Math.abs(dy);
    if (dx || dy) opts.onDragDelta(dx, dy);
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    canvas.releasePointerCapture(e.pointerId);
    opts.onDragState?.(false);
    if (moved < 6) opts.onClick();
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);

  return () => {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
  };
}
