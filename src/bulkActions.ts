import type { Constraint, Eligibility } from './types';

export const statusesForAll = (ids: string[], value: Eligibility | '') =>
  value ? Object.fromEntries(ids.map((id) => [id, value])) : {};

export const stationStatusesForAll = statusesForAll;

export const excludeAllExcept = (ids: string[], keptIds: string[]) => {
  const kept = new Set(keptIds);
  return Object.fromEntries(ids.filter((id) => !kept.has(id)).map((id) => [id, 'out' as const]));
};

export const setAllConstraintsEnabled = (constraints: Constraint[], enabled: boolean) =>
  constraints.map((constraint) => ({ ...constraint, enabled }));
