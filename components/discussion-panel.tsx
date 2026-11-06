"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** A docked desktop panel becomes a native, focus-contained modal on narrow screens. */
export function DiscussionPanel({ children, label, onClose, returnFocus }: {
  children: ReactNode;
  label: string;
  onClose(): void;
  returnFocus(): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef(returnFocus);
  useEffect(() => { returnFocusRef.current = returnFocus; }, [returnFocus]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const media = window.matchMedia("(max-width: 800px)");
    const previousOverflow = document.body.style.overflow;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      // Let a closing navigation drawer restore focus before this panel takes it.
      frame = requestAnimationFrame(() => {
        dialog.close();
        if (media.matches) {
          dialog.setAttribute("role", "dialog");
          dialog.setAttribute("aria-modal", "true");
          dialog.showModal();
          document.body.style.overflow = "hidden";
          dialog.querySelector<HTMLButtonElement>("[aria-label='Close side panel']")?.focus();
        } else {
          dialog.setAttribute("role", "complementary");
          dialog.removeAttribute("aria-modal");
          dialog.show();
          document.body.style.overflow = previousOverflow;
        }
      });
    };
    update();
    media.addEventListener("change", update);
    return () => {
      cancelAnimationFrame(frame);
      media.removeEventListener("change", update);
      dialog.close();
      document.body.style.overflow = previousOverflow;
      returnFocusRef.current();
    };
  }, []);

  return <dialog ref={ref} className="discussion-panel" aria-label={label}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onKeyDown={(event) => {
      if (event.key !== "Tab" || !event.currentTarget.matches(":modal")) return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex='0']")].filter((element) => element.getClientRects().length > 0);
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}
  >{children}</dialog>;
}
