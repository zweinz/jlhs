import { SF_BOUNDS, SF_CENTER } from './data';
import { GEOGRAPHIC_PARTITIONS, VISIBLE_POI_PARTITIONS } from './layers';
import { googleMapsLinkForPosition } from './mapLinks';
import { QUESTION_DEFINITIONS } from './questions';
import { transitRoutes, validStations } from './transit';
import type { AreaDisplayMode, Constraint, ManualReachBoundary, Position, QuestionKind, SharedState, TransitScope } from './types';

const kindValues = [
  'radar',
  'radius',
  'thermometer',
  'measuring',
  'coastline',
  'tentacle',
  'photo-reference',
  'endgame-confirmation',
  'direction',
  'closer',
  'farther',
  'matching-region',
  'intersection',
  'exclusion',
] as const satisfies readonly QuestionKind[];
const answerValues = ['yes', 'no', 'warmer', 'colder', 'closer', 'farther', 'null', 'not-within-reach'] as const;
const directionValues = ['north', 'south', 'east', 'west'] as const;
const kinds = new Set<string>(kindValues);
const answers = new Set<string>(answerValues);
const shareLayerKeys = [...new Set([
  ...VISIBLE_POI_PARTITIONS,
  ...GEOGRAPHIC_PARTITIONS.map(({ id }) => id),
  'station-zones',
  'transit-routes',
  'other-transit-routes',
  'partition-pins',
])];

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

export function validateManualReachBoundary(value: unknown): ManualReachBoundary {
  const boundary = value as ManualReachBoundary;
  if (!boundary || typeof boundary !== 'object' || typeof boundary.enabled !== 'boolean' ||
    typeof boundary.visible !== 'boolean' || !Array.isArray(boundary.regions) || boundary.regions.length > 20) {
    throw Error('Invalid manual reach boundary');
  }
  for (const region of boundary.regions) {
    if (!region || typeof region.id !== 'string' || !region.id || region.id.length > 100 ||
      !Array.isArray(region.points) || region.points.length < 3 || region.points.length > 200 ||
      region.points.some((position) => !validPosition(position))) {
      throw Error('Invalid manual reach region');
    }
  }
  return {
    enabled: boundary.enabled,
    visible: boundary.visible,
    regions: boundary.regions.map((region) => ({ id: region.id, points: region.points.map(({ lat, lng }) => ({ lat, lng })) })),
  };
}

export function validateState(value: unknown): SharedState {
  if (!value || typeof value !== 'object') throw Error('Configuration is not an object');
  const state = value as SharedState;
  const areaDisplayMode = (state.areaDisplayMode ?? 'excluded-red') as AreaDisplayMode;
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
      (candidate.answerSet !== undefined && typeof candidate.answerSet !== 'boolean') ||
      !validPosition(candidate.origin) ||
      (candidate.originSet !== undefined && typeof candidate.originSet !== 'boolean') ||
      (candidate.target !== undefined && !validPosition(candidate.target)) ||
      (candidate.targetSet !== undefined && typeof candidate.targetSet !== 'boolean') ||
      !validGoogleMapsUrl(candidate.originMapUrl) ||
      !validGoogleMapsUrl(candidate.targetMapUrl) ||
      (candidate.distanceMiles !== undefined &&
        (!Number.isFinite(candidate.distanceMiles) || candidate.distanceMiles <= 0 || candidate.distanceMiles > 100)) ||
      (candidate.category !== undefined && (typeof candidate.category !== 'string' || candidate.category.length > 100))
    ) {
      throw Error('Invalid constraint');
    }
  }
  if (state.endGameActive !== undefined && typeof state.endGameActive !== 'boolean') throw Error('Invalid end-game state');
  const manualReachBoundary = state.manualReachBoundary === undefined
    ? undefined
    : validateManualReachBoundary(state.manualReachBoundary);
  const { coastline: _removedCoastlineLayer, ...layers } = state.layers;
  return {
    ...state,
    layers: { ...layers, 'sticky-map': state.layers['sticky-map'] ?? true },
    areaDisplayMode,
    transitScope,
    endGameActive: state.endGameActive ?? false,
    manualReachBoundary,
  };
}

export function shareableState(state: SharedState) {
  return {
    ...state,
    hiderPosition: undefined,
    hiderMapUrl: undefined,
  } satisfies SharedState;
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
    areaDisplayMode: 'excluded-red',
    transitScope: 'all',
    stationStatuses: {},
    routeStatuses: {},
    endGameActive: false,
  };
}

const toBase64Url = (value: string) => btoa(unescape(encodeURIComponent(value)))
  .replaceAll('+', '-')
  .replaceAll('/', '_')
  .replace(/=+$/, '');

const fromBase64Url = (value: string) => {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  return decodeURIComponent(escape(atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))));
};

function encodeStatuses(ids: string[], statuses: Record<string, 'in' | 'out'>) {
  const bytes = new Uint8Array(Math.ceil(ids.length / 4));
  ids.forEach((id, index) => {
    const value = statuses[id] === 'in' ? 1 : statuses[id] === 'out' ? 2 : 0;
    bytes[Math.floor(index / 4)] |= value << ((index % 4) * 2);
  });
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeStatuses(ids: string[], value: unknown) {
  if (typeof value !== 'string' || value.length > Math.ceil(ids.length / 4) * 2) {
    throw new Error('Invalid compact eligibility filters');
  }
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  if (binary.length !== Math.ceil(ids.length / 4)) throw new Error('Truncated compact eligibility filters');
  const statuses: Record<string, 'in' | 'out'> = {};
  ids.forEach((id, index) => {
    const code = (binary.charCodeAt(Math.floor(index / 4)) >> ((index % 4) * 2)) & 3;
    if (code === 1) statuses[id] = 'in';
    if (code === 2) statuses[id] = 'out';
    if (code === 3) throw new Error('Invalid compact eligibility value');
  });
  return statuses;
}

type CompactStateV3 = {
  v: 3;
  state: SharedState;
  stations: string;
  routes: string;
};

function expandCompactState(value: unknown) {
  if (!value || typeof value !== 'object' || (value as { v?: unknown }).v !== 3) return value;
  const compact = value as CompactStateV3;
  if (!compact.state || typeof compact.state !== 'object') throw new Error('Invalid compact configuration');
  return {
    ...compact.state,
    stationStatuses: {
      ...compact.state.stationStatuses,
      ...decodeStatuses(validStations.map((station) => station.id), compact.stations),
    },
    routeStatuses: {
      ...compact.state.routeStatuses,
      ...decodeStatuses(transitRoutes.map((route) => route.id), compact.routes),
    },
  };
}

const COORDINATE_SCALE = 1_000_000;
const distanceKinds = new Set<QuestionKind>(['radar', 'radius', 'tentacle', 'closer', 'farther', 'intersection', 'exclusion']);
const targetKinds = new Set<QuestionKind>(['thermometer', 'closer', 'farther']);
const categoryKinds = new Set<QuestionKind>(['matching-region', 'measuring', 'tentacle']);
type CompactQuestionExtra = { t?: [number, number]; d?: number; r?: number; c?: string; i?: string };
type CompactQuestion = [number, number, number, number, CompactQuestionExtra?];
type CompactStateV4 = {
  v: 4;
  q?: CompactQuestion[];
  l: string;
  p: [number, number, number];
  z?: number;
  a?: 1;
  t?: 1;
  s?: string;
  r?: string;
  b?: [number, string[]];
};

function encodePosition(position: Position): [number, number] {
  return [
    Math.round((position.lat - SF_CENTER.lat) * COORDINATE_SCALE),
    Math.round((position.lng - SF_CENTER.lng) * COORDINATE_SCALE),
  ];
}

function decodePosition(lat: unknown, lng: unknown): Position {
  if (!Number.isInteger(lat) || !Number.isInteger(lng)) throw new Error('Invalid compact position');
  return {
    lat: Number((SF_CENTER.lat + Number(lat) / COORDINATE_SCALE).toFixed(6)),
    lng: Number((SF_CENTER.lng + Number(lng) / COORDINATE_SCALE).toFixed(6)),
  };
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlToBytes(value: unknown, maximumLength: number) {
  if (typeof value !== 'string' || value.length > maximumLength) throw new Error('Invalid compact binary field');
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function encodeLayerFlags(layers: Record<string, boolean>) {
  const bytes = new Uint8Array(Math.ceil(shareLayerKeys.length / 8));
  shareLayerKeys.forEach((key, index) => {
    const enabled = key === 'partition-pins' ? layers[key] !== false : Boolean(layers[key]);
    if (enabled) bytes[Math.floor(index / 8)] |= 1 << (index % 8);
  });
  return bytesToBase64Url(bytes);
}

function decodeLayerFlags(value: unknown) {
  const expectedLength = Math.ceil(shareLayerKeys.length / 8);
  const bytes = base64UrlToBytes(value, expectedLength * 2);
  if (bytes.length !== expectedLength) throw new Error('Truncated compact layer field');
  return Object.fromEntries(shareLayerKeys.map((key, index) => [key, Boolean(bytes[Math.floor(index / 8)] & (1 << (index % 8)))]));
}

function writeInt24(bytes: Uint8Array, offset: number, value: number) {
  if (!Number.isInteger(value) || value < -0x800000 || value > 0x7fffff) throw new Error('Compact coordinate is out of range');
  const encoded = value < 0 ? value + 0x1000000 : value;
  bytes[offset] = encoded >> 16;
  bytes[offset + 1] = encoded >> 8;
  bytes[offset + 2] = encoded;
}

function readInt24(bytes: Uint8Array, offset: number) {
  const value = (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
  return value & 0x800000 ? value - 0x1000000 : value;
}

function encodePositionPath(points: Position[]) {
  const bytes = new Uint8Array(points.length * 6);
  points.forEach((point, index) => {
    const [lat, lng] = encodePosition(point);
    writeInt24(bytes, index * 6, lat);
    writeInt24(bytes, index * 6 + 3, lng);
  });
  return bytesToBase64Url(bytes);
}

function decodePositionPath(value: unknown) {
  const bytes = base64UrlToBytes(value, 1_604);
  if (bytes.length % 6 !== 0 || bytes.length < 18 || bytes.length > 1_200) throw new Error('Invalid compact boundary path');
  return Array.from({ length: bytes.length / 6 }, (_, index) =>
    decodePosition(readInt24(bytes, index * 6), readInt24(bytes, index * 6 + 3)));
}

function constraintAffectsMap(constraint: Constraint) {
  return constraint.enabled && constraint.answer !== 'null' &&
    constraint.kind !== 'photo-reference' && constraint.kind !== 'endgame-confirmation';
}

function encodeConstraint(constraint: Constraint): CompactQuestion {
  const [lat, lng] = encodePosition(constraint.origin);
  const compact: CompactQuestion = [kindValues.indexOf(constraint.kind), answerValues.indexOf(constraint.answer), lat, lng];
  const extra: CompactQuestionExtra = {};
  if (targetKinds.has(constraint.kind) && constraint.target) extra.t = encodePosition(constraint.target);
  if (distanceKinds.has(constraint.kind) && constraint.distanceMiles !== undefined) extra.d = Number(constraint.distanceMiles.toFixed(6));
  if (constraint.kind === 'direction' && constraint.direction) extra.r = directionValues.indexOf(constraint.direction);
  if (categoryKinds.has(constraint.kind) && constraint.category) extra.c = constraint.category;
  if ((constraint.kind === 'matching-region' || constraint.kind === 'tentacle') && constraint.regionId) extra.i = constraint.regionId;
  if (Object.keys(extra).length) compact.push(extra);
  return compact;
}

function decodeConstraint(value: unknown, index: number): Constraint {
  if (!Array.isArray(value) || value.length < 4 || value.length > 5) throw new Error('Invalid compact question');
  if (!Number.isInteger(value[0]) || !Number.isInteger(value[1])) throw new Error('Invalid compact question kind or answer');
  const kind = kindValues[value[0] as number];
  const answer = answerValues[value[1] as number];
  if (!kind || !answer) throw new Error('Invalid compact question kind or answer');
  const origin = decodePosition(value[2], value[3]);
  const extra = (value[4] ?? {}) as CompactQuestionExtra;
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('Invalid compact question details');
  if (extra.t !== undefined && (!Array.isArray(extra.t) || extra.t.length !== 2)) throw new Error('Invalid compact question target');
  const target = extra.t ? decodePosition(extra.t[0], extra.t[1]) : undefined;
  if (extra.d !== undefined && (!Number.isFinite(extra.d) || extra.d <= 0 || extra.d > 100)) throw new Error('Invalid compact question distance');
  if (extra.r !== undefined && (!Number.isInteger(extra.r) || !directionValues[extra.r])) throw new Error('Invalid compact question direction');
  if (extra.c !== undefined && (typeof extra.c !== 'string' || extra.c.length > 100)) throw new Error('Invalid compact question category');
  if (extra.i !== undefined && (typeof extra.i !== 'string' || extra.i.length > 150)) throw new Error('Invalid compact question region');
  return {
    id: `shared-${index + 1}`,
    name: QUESTION_DEFINITIONS[kind].label,
    kind,
    enabled: true,
    answer,
    answerSet: true,
    origin,
    originSet: true,
    originMapUrl: googleMapsLinkForPosition(origin),
    ...(target ? { target, targetSet: true, targetMapUrl: googleMapsLinkForPosition(target) } : {}),
    ...(extra.d !== undefined ? { distanceMiles: extra.d } : {}),
    ...(extra.r !== undefined ? { direction: directionValues[extra.r] } : {}),
    ...(extra.c !== undefined ? { category: extra.c } : {}),
    ...(extra.i !== undefined ? { regionId: extra.i } : {}),
  };
}

function compactStateV4(state: SharedState): CompactStateV4 {
  const constraints = state.constraints.filter(constraintAffectsMap).map(encodeConstraint);
  const knownStationStatuses = Object.fromEntries(Object.entries(state.stationStatuses).filter(([id]) => validStations.some((station) => station.id === id)));
  const knownRouteStatuses = Object.fromEntries(Object.entries(state.routeStatuses).filter(([id]) => transitRoutes.some((route) => route.id === id)));
  const stationStatuses = Object.keys(knownStationStatuses).length
    ? encodeStatuses(validStations.map((station) => station.id), knownStationStatuses)
    : undefined;
  const routeStatuses = Object.keys(knownRouteStatuses).length
    ? encodeStatuses(transitRoutes.map((route) => route.id), knownRouteStatuses)
    : undefined;
  const boundary = state.manualReachBoundary && (state.manualReachBoundary.enabled || state.manualReachBoundary.visible)
    ? [
      (state.manualReachBoundary.enabled ? 1 : 0) | (state.manualReachBoundary.visible ? 2 : 0),
      state.manualReachBoundary.regions.map((region) => encodePositionPath(region.points)),
    ] as [number, string[]]
    : undefined;
  const [viewportLat, viewportLng] = encodePosition(state.viewport.center);
  return {
    v: 4,
    ...(constraints.length ? { q: constraints } : {}),
    l: encodeLayerFlags(state.layers),
    p: [viewportLat, viewportLng, Number(state.viewport.zoom.toFixed(2))],
    ...(state.stationZoneMiles !== 0.25 ? { z: Number(state.stationZoneMiles.toFixed(4)) } : {}),
    ...(state.areaDisplayMode === 'allowed-green' ? { a: 1 } : {}),
    ...(state.transitScope === 'primary' ? { t: 1 } : {}),
    ...(stationStatuses ? { s: stationStatuses } : {}),
    ...(routeStatuses ? { r: routeStatuses } : {}),
    ...(boundary ? { b: boundary } : {}),
  };
}

function expandCompactStateV4(value: unknown) {
  if (!value || typeof value !== 'object' || (value as { v?: unknown }).v !== 4) return value;
  const compact = value as CompactStateV4;
  if (!Array.isArray(compact.p) || compact.p.length !== 3 || !Number.isFinite(compact.p[2])) throw new Error('Invalid compact viewport');
  if (compact.q !== undefined && (!Array.isArray(compact.q) || compact.q.length > 200)) throw new Error('Invalid compact questions');
  if (compact.z !== undefined && (!Number.isFinite(compact.z) || compact.z < 0.05 || compact.z > 5)) throw new Error('Invalid compact station radius');
  if (compact.a !== undefined && compact.a !== 1) throw new Error('Invalid compact area display');
  if (compact.t !== undefined && compact.t !== 1) throw new Error('Invalid compact transit scope');
  let manualReachBoundary: ManualReachBoundary | undefined;
  if (compact.b !== undefined) {
    if (!Array.isArray(compact.b) || compact.b.length !== 2 || !Number.isInteger(compact.b[0]) || compact.b[0] < 1 || compact.b[0] > 3 || !Array.isArray(compact.b[1]) || compact.b[1].length > 20) {
      throw new Error('Invalid compact boundary');
    }
    manualReachBoundary = {
      enabled: Boolean(compact.b[0] & 1),
      visible: Boolean(compact.b[0] & 2),
      regions: compact.b[1].map((path, index) => ({ id: `shared-region-${index + 1}`, points: decodePositionPath(path) })),
    };
  }
  return {
    version: 2,
    constraints: (compact.q ?? []).map(decodeConstraint),
    layers: decodeLayerFlags(compact.l),
    viewport: { center: decodePosition(compact.p[0], compact.p[1]), zoom: compact.p[2] },
    mode: 'seeker',
    stationZoneMiles: compact.z ?? 0.25,
    areaDisplayMode: compact.a ? 'allowed-green' : 'excluded-red',
    transitScope: compact.t ? 'primary' : 'all',
    stationStatuses: compact.s === undefined ? {} : decodeStatuses(validStations.map((station) => station.id), compact.s),
    routeStatuses: compact.r === undefined ? {} : decodeStatuses(transitRoutes.map((route) => route.id), compact.r),
    endGameActive: false,
    manualReachBoundary,
  } satisfies SharedState;
}

export const encodeState = (state: SharedState) =>
  toBase64Url(JSON.stringify(compactStateV4(validateState(state))));

export const decodeState = (value: string) => {
  if (value.length > 50000) throw Error('Configuration is too large');
  try {
    return validateState(
      migrate(expandCompactState(expandCompactStateV4(JSON.parse(fromBase64Url(value))))),
    );
  } catch (error) {
    throw Error(`Cannot restore configuration: ${error instanceof Error ? error.message : 'malformed payload'}`);
  }
};
