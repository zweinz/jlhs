import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLongPressController, MAP_LONG_PRESS_MS } from './longPress';

describe('map long press', () => {
  afterEach(() => vi.useRealTimers());

  it('drops a pin only after a stationary hold and suppresses its release click', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const onLongPress = vi.fn();
    const controller = createLongPressController(onLongPress);
    controller.start({ lat: 37.77, lng: -122.44 });
    vi.advanceTimersByTime(MAP_LONG_PRESS_MS - 1);
    expect(onLongPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLongPress).toHaveBeenCalledWith({ lat: 37.77, lng: -122.44 });
    expect(controller.shouldSuppressClick()).toBe(true);
    vi.setSystemTime(2_451);
    expect(controller.shouldSuppressClick()).toBe(false);
  });

  it('does nothing when a drag or early release cancels the hold', () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const controller = createLongPressController(onLongPress);
    controller.start({ lat: 37.77, lng: -122.44 });
    controller.cancel();
    vi.advanceTimersByTime(MAP_LONG_PRESS_MS);
    expect(onLongPress).not.toHaveBeenCalled();
  });
});
