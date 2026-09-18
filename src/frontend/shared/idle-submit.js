export function createIdleSubmit({
  delayMs = 300,
  onSubmit,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let timer = null;

  function cancel() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function schedule(value, enabled = true) {
    cancel();
    if (!enabled || !value.trim()) return;
    timer = setTimer(() => {
      timer = null;
      onSubmit();
    }, delayMs);
  }

  return { schedule, cancel };
}
