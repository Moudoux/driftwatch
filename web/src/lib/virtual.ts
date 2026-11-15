import { type RefObject, useCallback, useEffect, useLayoutEffect, useReducer, useRef } from "react";

/**
 * A small virtualizer for append-heavy lists such as log tails.
 *
 * Row offsets live in a typed array that is only extended for new rows, so
 * appending is O(new rows) rather than O(all rows). Pass a new `epoch` when
 * rows were removed or reordered, and a new `layoutKey` when row heights may
 * have changed (width, wrapping, ...). With `measure`, rendered rows are
 * measured once and the measurement replaces the estimate.
 */
export function useAppendVirtualizer({
  scrollRef,
  count,
  estimate,
  keyOf,
  measure,
  layoutKey,
  epoch,
  follow,
  overscan = 600,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  count: number;
  estimate: (i: number) => number;
  keyOf: (i: number) => number;
  measure: boolean;
  layoutKey: string;
  epoch: unknown;
  follow: boolean;
  overscan?: number;
}) {
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const st = useRef({
    offsets: new Float64Array(1024),
    len: 0,
    epoch: undefined as unknown,
    layoutKey: "",
    sizes: new Map<number, number>(),
    scrollTop: 0,
    viewport: 0,
    follow,
  }).current;
  st.follow = follow;

  if (st.layoutKey !== layoutKey) {
    st.layoutKey = layoutKey;
    st.sizes.clear();
    st.len = 0;
  }
  if (st.epoch !== epoch || count < st.len) {
    st.epoch = epoch;
    st.len = 0;
  }
  if (st.offsets.length < count + 1) {
    const next = new Float64Array(Math.max(count + 1, Math.ceil(st.offsets.length * 1.5)));
    next.set(st.offsets.subarray(0, st.len + 1));
    st.offsets = next;
  }
  const off = st.offsets;
  for (let i = st.len; i < count; i++) off[i + 1] = off[i] + (st.sizes.get(keyOf(i)) ?? estimate(i));
  st.len = count;

  const total = off[count];
  const top = follow ? Math.max(0, total - st.viewport) : st.scrollTop;
  // First row whose bottom edge is below `y`.
  const find = (y: number) => {
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (off[mid + 1] <= y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const start = find(top - overscan);
  const end = Math.min(count, find(top + st.viewport + overscan) + 1);

  // Track scroll position and viewport size. While following, the list is
  // pinned to the bottom, so scroll events need no re-render.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const onScroll = () => {
      st.scrollTop = el.scrollTop;
      if (st.follow || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        rerender();
      });
    };
    const ro = new ResizeObserver(() => {
      st.viewport = el.clientHeight;
      rerender();
    });
    st.viewport = el.clientHeight;
    el.addEventListener("scroll", onScroll, { passive: true });
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [scrollRef, st]);

  // Measure rows rendered for the first time, then pin to the bottom.
  const rowsRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (measure && rowsRef.current) {
      let dirty = Infinity;
      for (const child of rowsRef.current.children) {
        const el = child as HTMLElement;
        const i = Number(el.dataset.i);
        const k = keyOf(i);
        if (st.sizes.has(k)) continue;
        const h = el.offsetHeight;
        st.sizes.set(k, h);
        if (h !== off[i + 1] - off[i]) dirty = Math.min(dirty, i);
      }
      if (dirty < Infinity) {
        st.len = Math.min(st.len, dirty);
        rerender();
        return;
      }
    }
    const el = scrollRef.current;
    if (follow && el) {
      el.scrollTop = el.scrollHeight;
      st.scrollTop = el.scrollTop;
    }
  });

  const offsetOf = useCallback((i: number) => st.offsets[i], [st]);
  return { start, end, total, offsetOf, rowsRef };
}
