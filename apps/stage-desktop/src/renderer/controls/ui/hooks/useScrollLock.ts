import { useCallback, useEffect, useRef, useState } from "react";
import { scrollToBottom } from "../lib/utils";

export type UseScrollLockResult = {
  timelineRef: React.RefObject<HTMLDivElement | null>;
  scrollLock: boolean;
  jumpToBottom: () => void;
};

/**
 * Custom hook for managing scroll lock behavior in chat timelines.
 * Auto-scrolls to bottom when new content arrives, unless user has scrolled up.
 */
export function useScrollLock(deps: unknown[] = []): UseScrollLockResult {
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const [scrollLock, setScrollLock] = useState(false);

  // Scroll heuristic: lock when user scrolls up more than 120px from bottom
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;

    const onScroll = () => {
      const gap = el.scrollHeight - (el.scrollTop + el.clientHeight);
      const locked = gap > 120;
      stickToBottomRef.current = !locked;
      setScrollLock(locked);
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Auto-scroll when dependencies change (new messages, etc.)
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      scrollToBottom(el);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const jumpToBottom = useCallback(() => {
    const el = timelineRef.current;
    if (el) scrollToBottom(el);
    setScrollLock(false);
    stickToBottomRef.current = true;
  }, []);

  return {
    timelineRef,
    scrollLock,
    jumpToBottom
  };
}
