import type { CodeViewScrollTarget } from "@pierre/diffs";

/** CodeView knows its file headers; additionally account for the app's sticky controls. */
export function reviewScrollTarget(target: CodeViewScrollTarget, stickyHeight: number): CodeViewScrollTarget {
  if (target.type === "position") return target;
  const adjustment = target.align === "center" ? -stickyHeight / 2 : target.align === "end" ? 0 : stickyHeight;
  return { ...target, offset: (target.offset ?? 0) + adjustment };
}

/** Portal/inert visibility can settle after commit. Restore focus only to visible chrome. */
export function focusReviewControl(target: () => HTMLElement | null | undefined, settled: () => void) {
  let remainingFrames = 10;
  let frame: number;
  const focus = () => {
    const element = target();
    if (element?.isConnected && !element.closest("[inert]") && getComputedStyle(element).visibility === "visible") {
      element.focus({ preventScroll: true });
      settled();
    } else if (--remainingFrames > 0) frame = requestAnimationFrame(focus);
    else settled();
  };
  frame = requestAnimationFrame(focus);
  return () => cancelAnimationFrame(frame);
}
