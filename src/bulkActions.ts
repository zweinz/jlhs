import type { Constraint, Eligibility } from './types';

export const stationStatusesForAll = (ids: string[], value: Eligibility | '') =>
  value ? Object.fromEntries(ids.map((id) => [id, value])) : {};

export const setAllConstraintsEnabled = (constraints: Constraint[], enabled: boolean) =>
  constraints.map((constraint) => ({ ...constraint, enabled }));
