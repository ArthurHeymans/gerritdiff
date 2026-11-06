import "./helpers/components.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
const { createReviewEditorStore } = await import("../components/review-editor-context.tsx");
const reply = { kind: "reply", key: "gerrit:one", message: "Unfinished reply", resolved: true };
const scope = { kind: "scope", key: null, path: "/PATCHSET_LEVEL", message: "Unfinished scope comment", resolved: false };

test("editor buffers survive remounts without changing last-edited order on a read-only render", () => {
  const storage = new Map();
  globalThis.window = { sessionStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  } };
  const store = createReviewEditorStore("comparison-2", () => assert.fail("storage works"));
  store.write("reply:one", reply);
  store.write("scope", scope);
  store.write("reply:one", { ...reply });
  assert.equal(store.all().at(-1).id, "scope");
  const remounted = createReviewEditorStore("comparison-2", () => assert.fail("storage works"));
  assert.deepEqual(remounted.read("reply:one"), reply);
  assert.deepEqual(remounted.read("scope"), scope);
  assert.equal(createReviewEditorStore("comparison-1", () => {}).all().length, 0);
  remounted.write("reply:one", null);
  remounted.write("scope", null);
  assert.equal(storage.size, 0);
});

test("denied tab storage preserves in-memory buffers and reports the failure", () => {
  let failures = 0;
  globalThis.window = { sessionStorage: {
    getItem() { throw new Error("denied"); },
    setItem() { throw new Error("denied"); },
  } };
  const store = createReviewEditorStore("comparison-2", () => failures++);
  store.write("reply:one", reply);
  assert.deepEqual(store.read("reply:one"), reply);
  assert.equal(failures, 1);
});
