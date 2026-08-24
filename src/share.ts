import { SF_BOUNDS } from './data';
import type { AreaDisplayMode, Constraint, Position, SharedState, TransitScope } from './types';

const kinds = new Set([
  'radar',
  'radius',
  'thermometer',
  'measuring',
  'coastline',
  'tentacle',
  'photo-reference',
  'direction',
  'closer',
  'farther',
  'matching-region',
  'intersection',
  'exclusion',
]);
const answers = new Set(['yes', 'no', 'warmer', 'colder', 'closer', 'farther', 'not-within-reach']);

function validPosition(position: Position | undefined) {
  return (
    !!position &&
    Number.isFinite(position.lat) &&
    Number.isFinite(position.lng) &&
    position.lat >= SF_BOUNDS.south &&
    position.lat <= SF_BOUNDS.north &&
    position.lng >= SF_BOUNDS.west &&
    position.lng <= SF_BOUNDS.east
  );
}

function validGoogleMapsUrl(value: unknown) {
  if (value === undefined) return true;
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'maps.app.goo.gl' || host === 'goo.gl' || host === 'maps.google.com' || host.endsWith('.google.com');
  } catch {
    return false;
  }
}

export function validateState(value: unknown): SharedState {
  if (!value || typeof value !== 'object') throw Error('Configuration is not an object');
  const state = value as SharedState;
  const areaDisplayMode = (state.areaDisplayMode ?? 'allowed-green') as AreaDisplayMode;
  const transitScope = (state.transitScope ?? 'all') as TransitScope;
  if (
    state.version !== 2 ||
    !Array.isArray(state.constraints) ||
    state.constraints.length > 200 ||
    !state.viewport ||
    !state.layers ||
    typeof state.layers !== 'object' ||
    !['seeker', 'hider'].includes(state.mode) ||
    !Number.isFinite(state.stationZoneMiles) ||
    state.stationZoneMiles < 0.05 ||
    state.stationZoneMiles > 5 ||
    !state.stationStatuses ||
    !state.routeStatuses
  ) {
    throw Error('Unsupported or incomplete configuration');
  }
  if (!['allowed-green', 'excluded-red'].includes(areaDisplayMode)) throw Error('Invalid area display mode');
  if (!['all', 'primary'].includes(transitScope)) throw Error('Invalid transit scope');
  if (!validPosition(state.viewport.center) || !Number.isFinite(state.viewport.zoom) || state.viewport.zoom < 8 || state.viewport.zoom > 22) {
    throw Error('Invalid viewport');
  }
  if (Object.values(state.layers).some((enabled) => typeof enabled !== 'boolean')) throw Error('Invalid layers');
  if (state.hiderPosition !== undefined && !validPosition(state.hiderPosition)) throw Error('Invalid hider position');
  if (!validGoogleMapsUrl(state.hiderMapUrl)) throw Error('Invalid hider map URL');
  for (const statuses of [state.stationStatuses, state.routeStatuses]) {
    if (typeof statuses !== 'object' || Object.keys(statuses).length > 500) throw Error('Invalid eligibility filters');
    if (Object.entries(statuses).some(([id, status]) => !id || id.length > 150 || !['in', 'out'].includes(status))) {
      throw Error('Invalid eligibility filters');
    }
  }
  for (const candidate of state.constraints as Constraint[]) {
    if (
      !candidate ||
      typeof candidate.id !== 'string' ||
      candidate.id.length > 100 ||
      typeof candidate.name !== 'string' ||
      candidate.name.length > 200 ||
      typeof candidate.enabled !== 'boolean' ||
      !kinds.has(candidate.kind) ||
      !answers.has(candidate.answer) ||
      !validPosition(candidate.origin) ||
      (candidate.target !== undefined && !validPosition(candidate.target)) ||
      !validGoogleMapsUrl(candidate.originMapUrl) ||
      !validGoogleMapsUrl(candidate.targetMapUrl) ||
      (candidate.distanceMiles !== undefined &&
        (!Number.isFinite(candidate.distanceMiles) || candidate.distanceMiles <= 0 || candidate.distanceMiles > 100)) ||
      (candidate.category !== undefined && (typeof candidate.category !== 'string' || candidate.category.length > 100))
    ) {
      throw Error('Invalid constraint');
    }
  }
  return { ...state, areaDisplayMode, transitScope };
}

function migrate(value: unknown) {
  if (!value || typeof value !== 'object') return value;
  const legacy = value as Record<string, unknown>;
  if (legacy.version !== 1) return value;
  return {
    ...legacy,
    version: 2,
    mode: 'seeker',
    stationZoneMiles: 0.25,
    areaDisplayMode: 'allowed-green',
    transitScope: 'all',
    stationStatuses: {},
    routeStatuses: {},
  };
}

export const encodeState = (state: SharedState) =>
  btoa(unescape(encodeURIComponent(JSON.stringify(validateState(state)))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

export const decodeState = (value: string) => {
  if (value.length > 50000) throw Error('Configuration is too large');
  try {
    return validateState(
      migrate(JSON.parse(decodeURIComponent(escape(atob(value.replaceAll('-', '+').replaceAll('_', '/')))))),
    );
  } catch (error) {
    throw Error(`Cannot restore configuration: ${error instanceof Error ? error.message : 'malformed payload'}`);
  }
};
