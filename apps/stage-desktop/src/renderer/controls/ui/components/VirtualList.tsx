import React, { useCallback, useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle } from "react";

export type VirtualListProps<T> = {
  items: T[];
  estimatedItemHeight: number;
  overscan?: number;
  renderItem: (item: T, index: number) => React.ReactNode;
  getItemKey: (item: T, index: number) => string | number;
  className?: string;
  onScroll?: (scrollTop: number, scrollHeight: number, clientHeight: number) => void;
};

export type VirtualListHandle = {
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  scrollToIndex: (index: number, behavior?: ScrollBehavior) => void;
  getScrollInfo: () => { scrollTop: number; scrollHeight: number; clientHeight: number };
};

/**
 * A lightweight virtual list component that renders only visible items.
 * Uses dynamic height measurement for accurate scrolling.
 */
function VirtualListInner<T>(
  props: VirtualListProps<T>,
  ref: React.ForwardedRef<VirtualListHandle>
) {
  const {
    items,
    estimatedItemHeight,
    overscan = 5,
    renderItem,
    getItemKey,
    className,
    onScroll
  } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const heightCache = useRef<Map<string | number, number>>(new Map());
  const observerRef = useRef<ResizeObserver | null>(null);
  const itemRefs = useRef<Map<string | number, HTMLDivElement>>(new Map());
  const [, forceUpdate] = useState(0);

  // Expose imperative methods
  useImperativeHandle(ref, () => ({
    scrollToBottom: (behavior: ScrollBehavior = "auto") => {
      const el = containerRef.current;
      if (el) {
        el.scrollTo({ top: el.scrollHeight, behavior });
      }
    },
    scrollToIndex: (index: number, behavior: ScrollBehavior = "auto") => {
      const el = containerRef.current;
      if (!el || index < 0 || index >= items.length) return;

      // Calculate position
      let top = 0;
      for (let i = 0; i < index; i++) {
        const key = getItemKey(items[i], i);
        top += heightCache.current.get(key) ?? estimatedItemHeight;
      }
      el.scrollTo({ top, behavior });
    },
    getScrollInfo: () => {
      const el = containerRef.current;
      if (!el) return { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
      return {
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight
      };
    }
  }), [items, getItemKey, estimatedItemHeight]);

  // Calculate total height and item positions
  const { totalHeight, itemPositions } = useMemo(() => {
    const positions: { top: number; height: number; key: string | number }[] = [];
    let currentTop = 0;

    for (let i = 0; i < items.length; i++) {
      const key = getItemKey(items[i], i);
      const height = heightCache.current.get(key) ?? estimatedItemHeight;
      positions.push({ top: currentTop, height, key });
      currentTop += height;
    }

    return { totalHeight: currentTop, itemPositions: positions };
  }, [items, getItemKey, estimatedItemHeight, heightCache.current.size]);

  // Find visible range using binary search
  const visibleRange = useMemo(() => {
    if (itemPositions.length === 0) {
      return { start: 0, end: 0 };
    }

    // Binary search for start index
    let start = 0;
    let end = itemPositions.length - 1;

    while (start < end) {
      const mid = Math.floor((start + end) / 2);
      if (itemPositions[mid].top + itemPositions[mid].height < scrollTop) {
        start = mid + 1;
      } else {
        end = mid;
      }
    }

    const startIndex = Math.max(0, start - overscan);

    // Find end index
    const viewportBottom = scrollTop + containerHeight;
    let endIndex = startIndex;

    while (endIndex < itemPositions.length && itemPositions[endIndex].top < viewportBottom) {
      endIndex++;
    }

    endIndex = Math.min(itemPositions.length, endIndex + overscan);

    return { start: startIndex, end: endIndex };
  }, [itemPositions, scrollTop, containerHeight, overscan]);

  // Handle scroll
  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    setScrollTop(container.scrollTop);
    onScroll?.(container.scrollTop, container.scrollHeight, container.clientHeight);
  }, [onScroll]);

  // Handle container resize
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver(() => {
      setContainerHeight(container.clientHeight);
    });

    resizeObserver.observe(container);
    setContainerHeight(container.clientHeight);

    return () => resizeObserver.disconnect();
  }, []);

  // Set up item height observer
  useEffect(() => {
    observerRef.current = new ResizeObserver((entries) => {
      let needsUpdate = false;

      for (const entry of entries) {
        const element = entry.target as HTMLDivElement;
        const key = element.dataset.virtualKey;
        if (key !== undefined) {
          const height = entry.contentRect.height;
          const cached = heightCache.current.get(key);
          if (cached !== height) {
            heightCache.current.set(key, height);
            needsUpdate = true;
          }
        }
      }

      // Force re-render if heights changed
      if (needsUpdate) {
        forceUpdate((n) => n + 1);
      }
    });

    return () => observerRef.current?.disconnect();
  }, []);

  // Register/unregister item refs for observation
  const setItemRef = useCallback((key: string | number, element: HTMLDivElement | null) => {
    const observer = observerRef.current;
    if (!observer) return;

    const existing = itemRefs.current.get(key);
    if (existing && existing !== element) {
      observer.unobserve(existing);
    }

    if (element) {
      itemRefs.current.set(key, element);
      observer.observe(element);
    } else {
      itemRefs.current.delete(key);
    }
  }, []);

  // Visible items to render
  const visibleItems = useMemo(() => {
    return items.slice(visibleRange.start, visibleRange.end).map((item, relativeIndex) => {
      const index = visibleRange.start + relativeIndex;
      const position = itemPositions[index];
      const key = position?.key ?? getItemKey(item, index);

      return {
        item,
        index,
        key,
        top: position?.top ?? 0
      };
    });
  }, [items, visibleRange, itemPositions, getItemKey]);

  // Top spacer height
  const topSpacerHeight = visibleItems.length > 0 ? visibleItems[0].top : 0;

  // Bottom spacer height
  const bottomSpacerHeight = visibleItems.length > 0
    ? totalHeight - (visibleItems[visibleItems.length - 1].top +
        (heightCache.current.get(visibleItems[visibleItems.length - 1].key) ?? estimatedItemHeight))
    : 0;

  return (
    <div
      ref={containerRef}
      className={className}
      onScroll={handleScroll}
      style={{ overflow: "auto" }}
    >
      {/* Top spacer */}
      <div style={{ height: topSpacerHeight, flexShrink: 0 }} />

      {/* Visible items */}
      {visibleItems.map(({ item, index, key }) => (
        <div
          key={key}
          ref={(el) => setItemRef(key, el)}
          data-virtual-key={key}
        >
          {renderItem(item, index)}
        </div>
      ))}

      {/* Bottom spacer */}
      <div style={{ height: Math.max(0, bottomSpacerHeight), flexShrink: 0 }} />
    </div>
  );
}

// Export with proper generic typing
export const VirtualList = forwardRef(VirtualListInner) as <T>(
  props: VirtualListProps<T> & { ref?: React.ForwardedRef<VirtualListHandle> }
) => React.ReactElement;
