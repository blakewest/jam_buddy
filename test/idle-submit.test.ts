import test from "node:test";
import assert from "node:assert/strict";
import { createIdleSubmit } from "../src/frontend/shared/idle-submit.js";

test("auto-submit waits 300 ms after the latest nonempty input", () => {
  const timers: { callback: () => void; delay: number }[] = [];
  const cleared: (ReturnType<typeof setTimeout> | number)[] = [];
  let submissions = 0;
  const idleSubmit = createIdleSubmit({
    delayMs: 300,
    onSubmit: () => { submissions++; },
    setTimer: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimer: id => cleared.push(id),
  });

  idleSubmit.schedule("add");
  idleSubmit.schedule("add hats");

  assert.equal(timers.length, 2);
  assert.equal(timers[1].delay, 300);
  assert.deepEqual(cleared, [1]);
  timers[1].callback();
  assert.equal(submissions, 1);
});

test("blank input or a disabled mode cancels auto-submit", () => {
  const timers: (() => void)[] = [];
  const cleared: (ReturnType<typeof setTimeout> | number)[] = [];
  const idleSubmit = createIdleSubmit({
    onSubmit: () => assert.fail("must not submit"),
    setTimer: callback => { timers.push(callback); return timers.length; },
    clearTimer: id => cleared.push(id),
  });

  idleSubmit.schedule("add hats");
  idleSubmit.schedule("", true);
  idleSubmit.schedule("add hats", false);

  assert.equal(timers.length, 1);
  assert.deepEqual(cleared, [1]);
});
