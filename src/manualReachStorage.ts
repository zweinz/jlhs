import { validateManualReachBoundary } from './share';
import type { ManualReachBoundary } from './types';

const STORAGE_KEY = 'sf-hiding-area-manual-reach-v1';
type BoundaryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function restoreManualReachBoundary(storage: BoundaryStorage, config: string) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { matched: false as const };
    const saved = JSON.parse(raw) as { version?: unknown; config?: unknown; boundary?: unknown };
    if (saved.version !== 1 || saved.config !== config) return { matched: false as const };
    if (saved.boundary === null) return { matched: true as const, boundary: undefined };
    return { matched: true as const, boundary: validateManualReachBoundary(saved.boundary) };
  } catch {
    try { storage.removeItem(STORAGE_KEY); } catch { /* Storage is unavailable. */ }
    return { matched: false as const };
  }
}

export function persistManualReachBoundary(
  storage: BoundaryStorage,
  config: string,
  boundary: ManualReachBoundary | undefined,
) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, config, boundary: boundary ?? null }));
  } catch {
    // The boundary still remains in the live board and explicit share URLs.
  }
}
