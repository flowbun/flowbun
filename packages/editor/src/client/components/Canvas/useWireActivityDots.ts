import { type RefObject, useEffect, useRef, useState } from "react";

const MAX_DOTS_PER_EDGE = 5;
const SPEED_VIEWPORT_FRACTION_PER_SEC = 0.25; // 25% of the browser viewport's width per second

export interface WireDot {
  id: number;
  duration: number;
}

/**
 * Spawns a short-lived "dot" descriptor every time `activitySeq` changes
 * (see FlowbunSocketContext's activity map — a version stamp that changes
 * whenever this wire's source node actually produces a value on this wire's
 * source port) — one dot per message, capped at MAX_DOTS_PER_EDGE in flight
 * on this wire at once. A spawn beyond the cap is just dropped: this is an
 * activity indicator, not a guaranteed-delivery animation queue, and the
 * real message has already been delivered near-instantly regardless of
 * whether its dot got to render.
 *
 * Duration is the wire's actual on-screen path length (measured off the
 * given hidden path element via the DOM's own getTotalLength(), so it
 * reflects the real bezier curve rather than a straight-line approximation)
 * divided by a constant speed — so a short, mostly-straight wire and a long,
 * sharply-curved one both move at the same visual rate instead of taking
 * the same time to cross very different distances.
 */
export function useWireActivityDots(
  activitySeq: number | undefined,
  pathRef: RefObject<SVGPathElement | null>,
): { dots: WireDot[]; handleDotDone: (id: number) => void } {
  const [dots, setDots] = useState<WireDot[]>([]);
  const nextId = useRef(0);
  // Baseline captured at mount, not 0/undefined — otherwise a wire that
  // already had activity before this component existed (e.g. switching back
  // to a flow tab) would spawn a spurious dot for old news on remount.
  const lastSeen = useRef(activitySeq);

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathRef is a stable ref object; reading .current here is intentionally not reactive (React refs are exempt from this rule by design)
  useEffect(() => {
    if (activitySeq === undefined || activitySeq === lastSeen.current) return;
    lastSeen.current = activitySeq;
    const length = pathRef.current?.getTotalLength();
    if (!length) return;
    const speed = window.innerWidth * SPEED_VIEWPORT_FRACTION_PER_SEC;
    const duration = length / speed;
    setDots((prev) =>
      prev.length >= MAX_DOTS_PER_EDGE
        ? prev
        : [...prev, { id: nextId.current++, duration }],
    );
  }, [activitySeq]);

  function handleDotDone(id: number) {
    setDots((prev) => prev.filter((d) => d.id !== id));
  }

  return { dots, handleDotDone };
}
