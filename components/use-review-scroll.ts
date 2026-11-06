"use client";

import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { focusReviewControl } from "@/lib/review-scroll";

type Mounts = { overview: HTMLDivElement; sticky: HTMLDivElement; scroll: HTMLDivElement };

/** Add measured React chrome to CodeView's own scroll surface, not another scroller. */
export function useReviewScroll(scrollRef: RefObject<HTMLDivElement | null>, forceSticky = false, preservePosition?: (position: number, nextOverviewHeight: number) => void) {
  const [mounts, setMounts] = useState<Mounts | null>(null);
  const overviewRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const preservedScroll = useRef<number | null>(null);
  const focusOverview = useRef(false);
  const [sizes, setSizes] = useState({ overview: 0, sticky: 0 });
  const sizesRef = useRef(sizes);
  const [stuck, setStuck] = useState(false);

  const attachScroll = useCallback((scroll: HTMLDivElement | null) => {
    scrollRef.current?.querySelector(":scope > .review-overview-host")?.remove();
    scrollRef.current?.querySelector(":scope > .review-sticky-host")?.remove();
    scrollRef.current = scroll;
    if (!scroll) { setMounts(null); return; }
    const overview = document.createElement("div");
    overview.className = "review-overview-host";
    const sticky = document.createElement("div");
    sticky.className = "review-sticky-host";
    // Keep DOM/keyboard order aligned with visual order. Neither host adds flow height.
    scroll.prepend(overview, sticky);
    setMounts({ overview, sticky, scroll });
  }, [scrollRef]);

  useLayoutEffect(() => {
    if (!mounts || !overviewRef.current || !stickyRef.current) return;
    const measure = () => {
      const overview = Math.ceil(overviewRef.current?.getBoundingClientRect().height ?? 0);
      const sticky = Math.ceil(stickyRef.current?.getBoundingClientRect().height ?? 0);
      const previous = sizesRef.current;
      if (overview === previous.overview && sticky === previous.sticky) return;
      // Expanding context at the top should not make CodeView anchor itself past it.
      // Once reading code, let its normal line anchoring preserve the current location.
      if (previous.overview === 0 || mounts.scroll.scrollTop < previous.overview) {
        preservedScroll.current = mounts.scroll.scrollTop;
        preservePosition?.(mounts.scroll.scrollTop, overview);
      }
      sizesRef.current = { overview, sticky };
      mounts.scroll.style.setProperty("--review-sticky-height", `${sticky}px`);
      setSizes({ overview, sticky });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(overviewRef.current);
    observer.observe(stickyRef.current);
    measure();
    return () => observer.disconnect();
  }, [mounts, preservePosition]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!mounts || !scroll) return;
    if (preservedScroll.current !== null) {
      scroll.scrollTop = preservedScroll.current;
      preservedScroll.current = null;
    }
    const update = () => {
      const next = forceSticky || (sizes.overview > 0 && scroll.scrollTop >= Math.max(1, sizes.overview - sizes.sticky));
      const active = document.activeElement;
      const hiding = next ? mounts.overview : mounts.sticky;
      if (active instanceof HTMLElement && hiding.contains(active)) scroll.focus({ preventScroll: true });
      scroll.dataset.reviewStuck = String(next);
      setStuck(next);
    };
    scroll.addEventListener("scroll", update, { passive: true });
    update();
    return () => scroll.removeEventListener("scroll", update);
  }, [forceSticky, mounts, scrollRef, sizes]);

  useLayoutEffect(() => {
    // Wait for React to remove inert, not merely for the scroll event to show the host.
    if (stuck || !focusOverview.current) return;
    return focusReviewControl(() => headingRef.current, () => { focusOverview.current = false; });
  }, [stuck]);

  const returnToOverview = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    // This is explicit navigation, not a scroll-triggered resize or an automatic jump.
    focusOverview.current = true;
    scroll.scrollTo({ top: 0, behavior: "instant" });
    if (!stuck && !forceSticky) {
      focusOverview.current = false;
      headingRef.current?.focus({ preventScroll: true });
    }
  }, [forceSticky, scrollRef, stuck]);

  return { mounts, attachScroll, overviewRef, stickyRef, headingRef, overviewHeight: sizes.overview, stickyHeight: sizes.sticky, stuck, ready: sizes.overview > 0, returnToOverview };
}
