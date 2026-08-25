import * as turf from '@turf/turf';
import { QUESTION_DEFINITIONS } from './questions';
import type { Constraint, Position, SharedState } from './types';

export type SoloPhase = 'seeking' | 'end-game' | 'found' | 'gave-up';

export type SoloPhotoKind =
  | 'any-building-visible-from-station'
  | 'widest-street'
  | 'a-tree'
  | 'tallest-structure-in-your-sightline'
  | 'the-sky'
  | 'tallest-building-visible-from-station'
  | 'two-buildings';

export type LegacySoloPhotoKind =
  | 'cardinal-view'
  | 'toward-station'
  | 'away-from-station'
  | 'sky-above'
  | 'ground-and-path'
  | 'wide-streetscape';

export type AnySoloPhotoKind = SoloPhotoKind | LegacySoloPhotoKind;

export const SOLO_PHOTO_SUBJECTS: Array<{ id: SoloPhotoKind; label: string; help: string }> = [
  { id: 'any-building-visible-from-station', label: 'Any building visible from station', help: 'Rulebook-card approximation from the station panorama, framed upward to include a nearby building.' },
  { id: 'widest-street', label: 'Widest street', help: 'Rulebook-card approximation using a wide view from the committed hiding panorama.' },
  { id: 'a-tree', label: 'A tree', help: 'Rulebook-card approximation using a narrower streetscape view from the committed hiding panorama.' },
  { id: 'tallest-structure-in-your-sightline', label: 'Tallest structure in your sightline', help: 'Rulebook-card approximation pitched upward from the committed hiding panorama.' },
  { id: 'the-sky', label: 'The sky', help: 'Rulebook-card approximation aimed straight up from the committed hiding panorama.' },
  { id: 'tallest-building-visible-from-station', label: 'Tallest building visible from station', help: 'Medium-game rulebook-card approximation from the station panorama, using a different view from the any-building card.' },
  { id: 'two-buildings', label: 'Two buildings', help: 'Medium-game rulebook-card approximation using a wide streetscape from the committed hiding panorama.' },
];

export const LEGACY_SOLO_PHOTO_KINDS: LegacySoloPhotoKind[] = [
  'cardinal-view',
  'toward-station',
  'away-from-station',
  'sky-above',
  'ground-and-path',
  'wide-streetscape',
];

const legacyPhotoMigration: Record<LegacySoloPhotoKind, SoloPhotoKind> = {
  'cardinal-view': 'a-tree',
  'toward-station': 'any-building-visible-from-station',
  'away-from-station': 'tallest-building-visible-from-station',
  'sky-above': 'the-sky',
  'ground-and-path': 'widest-street',
  'wide-streetscape': 'two-buildings',
};

export function migrateSoloPhotoKind(value?: string) {
  return value && LEGACY_SOLO_PHOTO_KINDS.includes(value as LegacySoloPhotoKind)
    ? legacyPhotoMigration[value as LegacySoloPhotoKind]
    : value;
}

export type SoloQuestionRecord = {
  id: string;
  displayText: string;
  repetition: number;
  cardsDrawn: number;
  cardsKept: number;
  photoUrl?: string;
};

export function publicSoloDisplayText(kind: Constraint['kind'], displayText: string) {
  if (kind === 'matching-region') {
    if (displayText.startsWith('Yes')) return 'Yes';
    if (displayText.startsWith('No')) return 'No';
    return 'Null';
  }
  if (kind === 'measuring' || kind === 'coastline') {
    if (displayText.startsWith('Closer')) return 'Closer';
    if (displayText.startsWith('Farther') || displayText.startsWith('Further')) return 'Further';
    return 'Null';
  }
  return displayText;
}

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
  cardsKept: number;
  phase: SoloPhase;
  departureTime: string;
  questions: Record<string, SoloQuestionRecord>;
  humanState: SharedState;
  boardState: SharedState;
  reveal?: SoloReveal;
};

export type SoloStartResponse = Pick<SoloClientSession, 'token' | 'commitment' | 'cardsDrawn' | 'cardsKept' | 'phase' | 'departureTime'>;

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

export function keptCardsForQuestion(constraint: Pick<Constraint, 'kind'>, priorUses: number) {
  const base = QUESTION_DEFINITIONS[constraint.kind].baseKeepCount ?? 0;
  return base * (priorUses + 1);
}

export function keptCardsFromQuestionUses(questionUses: Record<string, number>) {
  return Object.entries(questionUses).reduce((total, [key, uses]) => {
    const kind = key.split(':', 1)[0] as Constraint['kind'];
    const base = QUESTION_DEFINITIONS[kind]?.baseKeepCount ?? 0;
    return total + base * uses * (uses + 1) / 2;
  }, 0);
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

export type SoloPhotoPlan = {
  source: 'spot' | 'station';
  displayText: string;
  heading: number;
  pitch: number;
  fov: number;
};

const normalizedHeading = (heading: number) => ((heading % 360) + 360) % 360;

export function soloPhotoPlan(
  kind: AnySoloPhotoKind,
  spot: Position,
  station: Position,
  cardinalDirection: Constraint['direction'] = 'north',
  seededHeading = 0,
): SoloPhotoPlan {
  const toward = bearingDegrees(spot, station);
  const cardinal = { north: 0, east: 90, south: 180, west: 270 }[cardinalDirection ?? 'north'];
  const atSpot = (displayText: string, heading: number, pitch: number, fov: number): SoloPhotoPlan => ({
    source: 'spot', displayText, heading: normalizedHeading(heading), pitch, fov,
  });
  const atStation = (displayText: string, heading: number, pitch: number, fov: number): SoloPhotoPlan => ({
    source: 'station', displayText, heading: normalizedHeading(heading), pitch, fov,
  });

  if (kind === 'any-building-visible-from-station') {
    return atStation('Any building visible from station · Street View approximation taken at the hiding station', seededHeading, 8, 90);
  }
  if (kind === 'tallest-building-visible-from-station') {
    return atStation('Tallest building visible from station · Street View approximation taken at the hiding station', seededHeading + 180, 14, 75);
  }
  if (kind === 'widest-street') {
    return atSpot('Widest street · Street View approximation from the AI’s committed hiding spot', seededHeading + 90, 0, 120);
  }
  if (kind === 'a-tree') {
    return atSpot('A tree · Street View approximation from the AI’s committed hiding spot', seededHeading, 0, 75);
  }
  if (kind === 'tallest-structure-in-your-sightline') {
    return atSpot('Tallest structure in your sightline · Street View approximation from the AI’s committed hiding spot', seededHeading + 180, 14, 75);
  }
  if (kind === 'the-sky') {
    return atSpot('The sky · Street View approximation from the AI’s committed hiding spot', seededHeading, 90, 90);
  }
  if (kind === 'two-buildings') {
    return atSpot('Two buildings · Street View approximation from the AI’s committed hiding spot', seededHeading + 270, 0, 120);
  }

  // Preserve deterministic answers for already-created drafts from the earlier house-rule inventory.
  if (kind === 'cardinal-view') return atSpot('Cardinal view from the AI’s committed hiding spot', cardinal, 0, 90);
  if (kind === 'toward-station') return atSpot('View toward the hiding station from the AI’s committed hiding spot', toward, 0, 70);
  if (kind === 'away-from-station') return atSpot('View away from the hiding station from the AI’s committed hiding spot', toward + 180, 0, 110);
  if (kind === 'sky-above') return atSpot('Sky above the AI’s committed hiding spot', seededHeading, 90, 90);
  if (kind === 'ground-and-path') return atSpot('Ground and path at the AI’s committed hiding spot', toward, -45, 90);
  return atSpot('Wide streetscape from the AI’s committed hiding spot', seededHeading, 0, 120);
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
