import assert from "node:assert/strict";
import { test } from "node:test";
import { focusReviewControl, reviewScrollTarget } from "../lib/review-scroll.ts";

test("line and file navigation clears the sticky review controls without mutating targets", () => {
  const target = { type: "line", id: "file-0", lineNumber: 30, align: "start", offset: 8 };
  assert.deepEqual(reviewScrollTarget(target, 108), { ...target, offset: 116 });
  assert.equal(target.offset, 8);
  assert.deepEqual(reviewScrollTarget({ type: "item", id: "file-1" }, 108), { type: "item", id: "file-1", offset: 108 });
});

test("center navigation uses the unobscured viewport and bottom alignment stays unchanged", () => {
  assert.deepEqual(reviewScrollTarget({ type: "line", id: "file-0", lineNumber: 30, align: "center", offset: 10 }, 108), { type: "line", id: "file-0", lineNumber: 30, align: "center", offset: -44 });
  assert.deepEqual(reviewScrollTarget({ type: "item", id: "file-0", align: "end", offset: 8 }, 108), { type: "item", id: "file-0", align: "end", offset: 8 });
});

test("absolute overview navigation remains absolute", () => {
  const target = { type: "position", position: 0, behavior: "instant" };
  assert.equal(reviewScrollTarget(target, 108), target);
});

test("chrome focus waits for visibility, supports cancellation, and stops retrying", (context) => {
  const frames = new Map();
  let nextFrame = 0;
  let visible = false;
  let focused = 0;
  let settled = 0;
  const globals = {
    requestAnimationFrame: (callback) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id) => frames.delete(id),
    getComputedStyle: () => ({ visibility: visible ? "visible" : "hidden" }),
  };
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    context.after(() => { if (original) Object.defineProperty(globalThis, key, original); else delete globalThis[key]; });
  }
  const flushFrame = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback());
  };
  const element = { isConnected: true, closest: () => null, focus: (options) => { assert.deepEqual(options, { preventScroll: true }); focused++; } };
  focusReviewControl(() => element, () => settled++);
  flushFrame();
  assert.equal(focused, 0);
  visible = true;
  flushFrame();
  assert.equal(focused, 1);
  assert.equal(settled, 1);
  const cancel = focusReviewControl(() => element, () => settled++);
  cancel();
  flushFrame();
  assert.equal(focused, 1);
  focusReviewControl(() => null, () => settled++);
  for (let index = 0; index < 20; index++) flushFrame();
  assert.equal(frames.size, 0);
  assert.equal(settled, 2);
});
