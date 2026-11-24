import React, { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

type Snap = "peek" | "full";

const SNAP_FRACTION: Record<Snap, number> = { peek: 0.48, full: 0.9 };

/**
 * Draggable bottom sheet for phones. It sits inside a positioned container
 * (the map shell) and snaps to half or nearly full height. Dragging it most of
 * the way down closes it.
 */
export function BottomSheet({
  label,
  onClose,
  children,
  initial = "peek",
}: {
  label: string;
  onClose: () => void;
  children: React.ReactNode;
  initial?: Snap;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [snap, setSnap] = useState<Snap>(initial);
  const [dragPx, setDragPx] = useState<number | null>(null);
  const drag = useRef<{ startY: number; startH: number; parentH: number } | null>(null);

  useEffect(() => setSnap(initial), [initial]);

  const parentHeight = () => rootRef.current?.parentElement?.clientHeight ?? window.innerHeight;

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    const parentH = parentHeight();
    drag.current = { startY: e.clientY, startH: parentH * SNAP_FRACTION[snap], parentH };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const h = Math.min(d.parentH * 0.95, Math.max(80, d.startH - (e.clientY - d.startY)));
    setDragPx(h);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const moved = Math.abs(e.clientY - d.startY);
    const h = dragPx ?? d.startH;
    setDragPx(null);
    if (moved < 6) {
      // A tap toggles between the two heights
      setSnap((s) => (s === "peek" ? "full" : "peek"));
      return;
    }
    const f = h / d.parentH;
    if (f < 0.25) onClose();
    else setSnap(f < 0.68 ? "peek" : "full");
  };

  const height = dragPx !== null ? `${dragPx}px` : `${SNAP_FRACTION[snap] * 100}%`;

  return (
    <section
      ref={rootRef}
      aria-label={label}
      className="sh-sheet absolute left-0 right-0 bottom-0 z-30"
      style={{ height }}
    >
      <div className="flex items-start">
        <button
          type="button"
          className="sh-sheet-handle"
          aria-label={snap === "peek" ? "Expand panel" : "Shrink panel"}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            drag.current = null;
            setDragPx(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setSnap((s) => (s === "peek" ? "full" : "peek"));
            }
          }}
          style={{ height: 32 }}
        />
      </div>
      <button
        type="button"
        className="sh-btn sh-btn-icon sh-btn-quiet absolute right-1 top-1"
        aria-label={`Close ${label.toLowerCase()}`}
        onClick={onClose}
      >
        <X size={22} aria-hidden="true" />
      </button>
      <div className="sh-sheet-body">{children}</div>
    </section>
  );
}
