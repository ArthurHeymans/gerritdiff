"use client";

import { createContext, useContext, useEffect, useId } from "react";
import { parseReviewEditorBuffers, type ReviewEditorBuffer } from "@/lib/review-draft";

export function createReviewEditorStore(draftKey: string, onStorageError: () => void) {
  const storageKey = `${draftKey}:editors`;
  let entries: { id: string; value: ReviewEditorBuffer }[] | undefined;
  const all = () => {
    if (!entries) {
      try { entries = parseReviewEditorBuffers(window.sessionStorage.getItem(storageKey)); }
      catch { entries = []; }
    }
    return entries;
  };
  return {
    all,
    read: (id: string) => all().find((entry) => entry.id === id)?.value,
    write(id: string, value: ReviewEditorBuffer | null) {
      if (JSON.stringify(all().find((entry) => entry.id === id)?.value ?? null) === JSON.stringify(value)) return;
      entries = all().filter((entry) => entry.id !== id);
      if (value) entries.push({ id, value });
      try {
        if (entries.length) window.sessionStorage.setItem(storageKey, JSON.stringify(entries));
        else window.sessionStorage.removeItem(storageKey);
      } catch { onStorageError(); }
    },
  };
}

export const ReviewEditorContext = createContext<{
  register(key: string, dirty: boolean): void;
  store?: ReturnType<typeof createReviewEditorStore>;
}>({ register() {} });

export function useReviewEditorStore() { return useContext(ReviewEditorContext).store; }

/** Track active text even when a virtualized annotation owns the editor state. */
export function useUnsavedReviewEditor(key: string, dirty: boolean) {
  const { register } = useContext(ReviewEditorContext);
  const instanceId = useId();
  useEffect(() => {
    const instanceKey = `${key}:${instanceId}`;
    register(instanceKey, dirty);
    return () => register(instanceKey, false);
  }, [dirty, instanceId, key, register]);
}
