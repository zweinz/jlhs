export const MAP_LONG_PRESS_MS = 650;
const RELEASE_CLICK_SUPPRESSION_MS = 800;

export function createLongPressController<T>(
  onLongPress: (value: T) => void,
  delayMs = MAP_LONG_PRESS_MS,
  now = () => Date.now(),
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let suppressClickUntil = 0;

  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  return {
    start(value: T) {
      cancel();
      timer = setTimeout(() => {
        timer = undefined;
        suppressClickUntil = now() + RELEASE_CLICK_SUPPRESSION_MS;
        onLongPress(value);
      }, delayMs);
    },
    cancel,
    shouldSuppressClick() {
      return now() < suppressClickUntil;
    },
    dispose: cancel,
  };
}
