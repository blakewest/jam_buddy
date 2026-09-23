interface IdleSubmitOptions {
  delayMs?: number;
  onSubmit: () => void;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout> | number;
  clearTimer?: (timer: ReturnType<typeof setTimeout> | number) => void;
}

export function createIdleSubmit({
  delayMs = 300,
  onSubmit,
  setTimer = setTimeout,
  clearTimer = (timer: ReturnType<typeof setTimeout> | number) => clearTimeout(timer),
}: IdleSubmitOptions) {
  let timer: ReturnType<typeof setTimeout> | number | null = null;

  function cancel() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function schedule(value: string, enabled = true) {
    cancel();
    if (!enabled || !value.trim()) return;
    timer = setTimer(() => {
      timer = null;
      onSubmit();
    }, delayMs);
  }

  return { schedule, cancel };
}
