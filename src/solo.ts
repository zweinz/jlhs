import * as turf from '@turf/turf';
import { QUESTION_DEFINITIONS } from './questions';
import type { Constraint, Position, SharedState } from './types';

export type SoloPhase = 'seeking' | 'end-game' | 'found' | 'gave-up';

export type SoloPhotoKind =
  | 'cardinal-view'
  | 'toward-station'
  | 'away-from-station'
  | 'sky-above'
  | 'ground-and-path'
  | 'wide-streetscape';

export const SOLO_PHOTO_SUBJECTS: Array<{ id: SoloPhotoKind; label: string; help: string }> = [
  { id: 'cardinal-view', label: 'Cardinal view', help: 'Choose a north, east, south, or west Street View image.' },
  { id: 'toward-station', label: 'Toward the station', help: 'Street View aimed from the hiding spot toward the hiding station.' },
  { id: 'away-from-station', label: 'Away from the station', help: 'Street View aimed directly away from the hiding station.' },
  { id: 'sky-above', label: 'Sky above', help: 'Street View aimed straight up from the hiding spot.' },
  { id: 'ground-and-path', label: 'Ground and path', help: 'Street View pitched down toward the route to the station.' },
  { id: 'wide-streetscape', label: 'Wide streetscape', help: 'A repeatable, session-selected 120° street scene.' },
];

export type SoloQuestionRecord = {
  id: string;
  displayText: string;
  repetition: number;
  cardsDrawn: number;
  photoUrl?: string;
};

export type SoloReveal = {
  reason: 'found' | 'gave-up';
  station: { id: string; name: string; position: Position };
  spot: Position;
  panorama: { id: string; date?: string; imageUrl: string };
  route: {
    durationSeconds: number;
    distanceMeters: number;
    departureTime: string;
    arrivalTime: string;
    summary: string[];
  };
  sessionId: string;
  salt: string;
  commitment: string;
  commitmentValid?: boolean;
};

export type SoloClientSession = {
  token: string;
  commitment: string;
  cardsDrawn: number;
  phase: SoloPhase;
  departureTime: string;
  questions: Record<string, SoloQuestionRecord>;
  humanState: SharedState;
  boardState: SharedState;
  reveal?: SoloReveal;
};

export type SoloStartResponse = Pick<SoloClientSession, 'token' | 'commitment' | 'cardsDrawn' | 'phase' | 'departureTime'>;

export function canonicalQuestionKey(constraint: Pick<Constraint, 'kind' | 'distanceMiles' | 'category'>) {
  if (constraint.kind === 'radar' || constraint.kind === 'thermometer') {
    return `${constraint.kind}:${Number(constraint.distanceMiles ?? 0).toFixed(3)}`;
  }
  return `${constraint.kind}:${constraint.category ?? 'default'}`;
}

export function cardsForQuestion(constraint: Pick<Constraint, 'kind' | 'distanceMiles' | 'category'>, priorUses: number) {
  const base = QUESTION_DEFINITIONS[constraint.kind].baseDrawCount ?? 0;
  return base * (priorUses + 1);
}

export function stationDifficulty(durationSeconds: number, nearbyStations: number) {
  const durationScore = Math.max(0, Math.min(1, durationSeconds / 1800));
  const sparseScore = 1 - Math.max(0, Math.min(1, nearbyStations / 10));
  return 0.65 * durationScore + 0.35 * sparseScore;
}

export function nearbyStationCount(position: Position, stations: Position[], radiusMiles = 0.5) {
  return stations.filter((candidate) => turf.distance(
    [position.lng, position.lat],
    [candidate.lng, candidate.lat],
    { units: 'miles' },
  ) <= radiusMiles).length;
}

export function distanceMeters(a: Position, b: Position) {
  return turf.distance([a.lng, a.lat], [b.lng, b.lat], { units: 'kilometers' }) * 1000;
}

export function bearingDegrees(from: Position, to: Position) {
  return (turf.bearing([from.lng, from.lat], [to.lng, to.lat]) + 360) % 360;
}

export function photoCamera(
  kind: SoloPhotoKind,
  spot: Position,
  station: Position,
  cardinalDirection: Constraint['direction'] = 'north',
  seededHeading = 0,
) {
  const toward = bearingDegrees(spot, station);
  const cardinal = { north: 0, east: 90, south: 180, west: 270 }[cardinalDirection ?? 'north'];
  if (kind === 'cardinal-view') return { heading: cardinal, pitch: 0, fov: 90 };
  if (kind === 'toward-station') return { heading: toward, pitch: 0, fov: 90 };
  if (kind === 'away-from-station') return { heading: (toward + 180) % 360, pitch: 0, fov: 90 };
  if (kind === 'sky-above') return { heading: 0, pitch: 90, fov: 90 };
  if (kind === 'ground-and-path') return { heading: toward, pitch: -45, fov: 90 };
  return { heading: seededHeading % 360, pitch: 0, fov: 120 };
}

function sfOffsetMinutes(instant: Date) {
  const offset = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'longOffset',
  }).formatToParts(instant).find((part) => part.type === 'timeZoneName')?.value ?? 'GMT-08:00';
  const match = offset.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) return -480;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '+' ? minutes : -minutes;
}

export function sfLocalDateTimeToIso(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) throw new Error('Choose a valid San Francisco date and time.');
  const parts = match.slice(1).map(Number);
  const wallClockUtc = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4]);
  let candidate = new Date(wallClockUtc - sfOffsetMinutes(new Date(wallClockUtc)) * 60_000);
  candidate = new Date(wallClockUtc - sfOffsetMinutes(candidate) * 60_000);
  if (defaultSfDateTime(candidate) !== value) throw new Error('That local time does not exist in San Francisco because of daylight saving time.');
  return candidate.toISOString();
}

export function defaultSfDateTime(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}`;
}

export function soloStateForNewGame(base: SharedState): SharedState {
  return {
    ...base,
    mode: 'seeker',
    constraints: [],
    stationZoneMiles: 0.25,
    transitScope: 'all',
    stationStatuses: {},
    routeStatuses: {},
    hiderPosition: undefined,
    hiderMapUrl: undefined,
  };
}

export async function verifyRevealCommitment(reveal: SoloReveal) {
  const payload = {
    sessionId: reveal.sessionId,
    departureTime: reveal.route.departureTime,
    station: reveal.station,
    spot: reveal.spot,
    panorama: { id: reveal.panorama.id, ...(reveal.panorama.date ? { date: reveal.panorama.date } : {}) },
    route: reveal.route,
    salt: reveal.salt,
  };
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload))));
  let binary = '';
  digest.forEach((byte) => { binary += String.fromCharCode(byte); });
  const commitment = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  return commitment === reveal.commitment;
}
