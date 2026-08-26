import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('./style.css', import.meta.url)), 'utf8');

function variable(name: string) {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`Missing color variable --${name}`);
  return match[1];
}

function luminance(hex: string) {
  const channels = hex.slice(1).match(/../g)!.map((value) => parseInt(value, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string) {
  const [light, dark] = [luminance(a), luminance(b)].sort((left, right) => right - left);
  return (light + 0.05) / (dark + 0.05);
}

describe('facelift color contrast', () => {
  it.each(['blue', 'blue-dark', 'mint', 'mint-dark', 'coral', 'coral-dark'])('%s supports white button text', (name) => {
    expect(contrast('#ffffff', variable(name))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps body and helper text readable on both primary surfaces', () => {
    expect(contrast(variable('ink'), variable('surface'))).toBeGreaterThanOrEqual(7);
    expect(contrast(variable('muted'), variable('surface'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(variable('muted'), variable('surface-soft'))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the active gold preview control readable', () => {
    expect(contrast('#3b2500', '#f2c75c')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#3b2500', '#dba234')).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps all Xeno panel copy dark against its green-tinted surface', () => {
    expect(contrast(variable('solo-text'), variable('solo-surface'))).toBeGreaterThanOrEqual(7);
    expect(contrast(variable('solo-text-soft'), variable('solo-surface'))).toBeGreaterThanOrEqual(7);
  });
});
