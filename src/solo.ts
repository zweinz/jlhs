import * as turf from '@turf/turf';
import { QUESTION_DEFINITIONS, RULEBOOK_DISTANCE_CHOICES } from './questions';
import type { Constraint, Position, SharedState } from './types';
import type { CardId, CardKind } from './cards';

export type SoloPhase = 'seeking' | 'end-game' | 'found' | 'gave-up';

export type SoloPhotoKind =
  | 'a-tree'
  | 'the-sky'
  | 'you'
  | 'widest-street'
  | 'tallest-structure-in-your-sightline'
  | 'any-building-visible-from-station'
  | 'tallest-building-visible-from-station'
  | 'trace-nearest-street-path'
  | 'two-buildings'
  | 'restaurant-interior'
  | 'park'
  | 'grocery-store-aisle'
  | 'place-of-worship'
  | 'train-platform';

export type AnySoloPhotoKind = SoloPhotoKind;

export type SoloPhotoLocation = 'spot' | 'station' | 'zone' | 'static';

export const SOLO_PHOTO_LOCATIONS: Record<SoloPhotoKind, SoloPhotoLocation> = {
  'a-tree': 'zone',
  'the-sky': 'spot',
  you: 'static',
  'widest-street': 'zone',
  'tallest-structure-in-your-sightline': 'spot',
  'any-building-visible-from-station': 'station',
  'tallest-building-visible-from-station': 'station',
  'trace-nearest-street-path': 'spot',
  'two-buildings': 'zone',
  'restaurant-interior': 'zone',
  park: 'zone',
  'grocery-store-aisle': 'zone',
  'place-of-worship': 'zone',
  'train-platform': 'zone',
};

export function soloPhotoLocationNote(kind: SoloPhotoKind) {
  const notes: Record<SoloPhotoLocation, string> = {
    spot: 'Location: Xeno’s current position (updated after a move).',
    station: 'Location: the hiding zone’s central station, not Xeno’s current position.',
    zone: 'Location: elsewhere inside the hiding zone, not Xeno’s current position. No hiding-location fallback.',
    static: 'Location: none — a fixed Xeno selfie, not a location clue.',
  };
  return notes[SOLO_PHOTO_LOCATIONS[kind]] ?? 'Location: choose a supported Solo photo.';
}

export const SOLO_PHOTO_SUBJECTS: Array<{ id: SoloPhotoKind; label: string; help: string }> = [
  { id: 'a-tree', label: 'A tree', help: 'Best effort: aims outdoor Street View into a park elsewhere in the hiding zone. The entire tree cannot be visually guaranteed.' },
  { id: 'the-sky', label: 'The sky', help: 'Supported: a deterministic view aimed straight up at the hiding location.' },
  { id: 'you', label: 'You', help: 'Easter egg: Xeno supplies a suspiciously anonymous selfie. Free to ask; no cards are drawn or kept.' },
  { id: 'widest-street', label: 'Widest street', help: 'Solo house rule: any other mapped street inside the hiding zone, away from Xeno’s current position. It need not be the widest street.' },
  { id: 'tallest-structure-in-your-sightline', label: 'Tallest structure in your sightline', help: 'Approximate: an upward-framed deterministic view at the hiding location.' },
  { id: 'any-building-visible-from-station', label: 'Any building visible from station', help: 'Rulebook-card approximation from the station panorama, framed upward to include a nearby building.' },
  { id: 'tallest-building-visible-from-station', label: 'Tallest building visible from station', help: 'Medium-game rulebook-card approximation from the station panorama, using a different view from the any-building card.' },
  { id: 'trace-nearest-street-path', label: 'Trace nearest street/path', help: 'Approximate: shows the precomputed orientation of the nearest named DataSF street, with north up. It does not trace intersections or cover every park and unnamed path.' },
  { id: 'two-buildings', label: 'Two buildings', help: 'Best effort: a wide, horizon-level streetscape elsewhere in the hiding zone, separate from Xeno and the widest-street photo. The exact two-building framing cannot be guaranteed.' },
  { id: 'restaurant-interior', label: 'Restaurant interior', help: 'Best effort: outdoor Street View aimed toward a restaurant elsewhere in the hiding zone, approximating the required through-window view.' },
  { id: 'park', label: 'Park', help: 'Supported when a qualifying park elsewhere in the hiding zone has usable outdoor Street View away from Xeno’s current position.' },
  { id: 'grocery-store-aisle', label: 'Grocery store aisle', help: 'Best effort: searches qualifying stores elsewhere in the hiding zone and allows indoor Street View; the aisle framing cannot be guaranteed.' },
  { id: 'place-of-worship', label: 'Place of worship', help: 'Best effort: searches qualifying worship sites elsewhere in the hiding zone and aims available Street View at the place.' },
  { id: 'train-platform', label: 'Train platform', help: 'Best effort: targets a mapped rail station elsewhere in the hiding zone and allows indoor Street View for a platform or station scene.' },
];

export const soloPhotoOptionLabel = (subject: (typeof SOLO_PHOTO_SUBJECTS)[number]) =>
  subject.help.startsWith('Unavailable') ? `${subject.label} (unavailable)` : subject.label;

export type SoloQuestionRecord = {
  id: string;
  displayText: string;
  repetition: number;
  cardsDrawn: number;
  cardsKept: number;
  photoUrl?: string;
  outcome?: 'answered' | 'vetoed' | 'randomized';
  playedCards?: string[];
  randomizedFrom?: string;
  randomizedTo?: string;
};

export function answeredSoloConstraint(original: Constraint, replacement: Constraint | undefined, answer: Constraint['answer'], resolvedRegionId?: string) {
  return {
    ...(replacement ?? original),
    id: original.id,
    answer,
    answerSet: true,
    enabled: true,
    ...(resolvedRegionId ? { regionId: resolvedRegionId } : {}),
  } satisfies Constraint;
}

export function vetoedSoloConstraint(original: Constraint) {
  return { ...original, enabled: false } satisfies Constraint;
}

export type SoloPublicEffect = {
  id: string;
  cardId: CardId;
  name: string;
  description: string;
  status: 'pending' | 'active' | 'monitoring' | 'waiting' | 'failed';
  blocksQuestions: boolean;
  blocksTransit: boolean;
  failureBonusMinutes?: number;
  citationUrl?: string;
  placeName?: string;
  placePosition?: Position;
  mazeSvg?: string;
  hangmanPattern?: string;
  hangmanWrong?: string[];
  failureReported?: boolean;
  expiresAt?: string;
  currentRestriction?: string;
  disabledQuestionKeys?: string[];
  disabledCategory?: string;
  canClear?: boolean;
  canCompleteTask?: boolean;
  canReportFailure?: boolean;
  canVetoInfeasible?: boolean;
  castingInstruction?: string;
  completionInstruction: string;
  failureInstruction?: string;
  imageUrl?: string;
  detail?: string;
  lockedUntil?: string;
};

export type SoloMapEvidence = {
  id: string;
  kind: 'closer-to';
  label: string;
  nearer: Position;
  farther: Position;
  placeName?: string;
  positionRevision: number;
};

export type SoloPublicCardState = {
  handCount: number;
  maxHandSize: number;
  handCards?: Array<{
    id: CardId;
    kind: CardKind;
    name: string;
    description: string;
    count: number;
  }>;
  deckCount: number;
  discardCount: number;
  usedCount: number;
  activeCurses: SoloPublicEffect[];
  playHistory: string[];
  moves: Array<{ at: string; oldStation: { id: string; name: string; position: Position } }>;
  positionRevision: number;
  questionBlocked: boolean;
  nextQuestionFree: boolean;
  nextRewardExtraDraw: number;
  strategy: {
    calls: number;
    limit: number;
    mapsCalls: number;
    mapsLimit: number;
    fallback: boolean;
    fallbackReason?: 'call-limit' | 'budget';
    available: boolean;
  };
  bonusMinutes: number;
  evidence?: SoloMapEvidence[];
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
  reason: 'found' | 'gave-up' | 'peek';
  station: { id: string; name: string; position: Position };
  spot: Position;
  panorama: { id: string; date?: string; imageUrl: string };
  stationPanorama?: { id: string; date?: string };
  route: {
    durationSeconds: number;
    distanceMeters: number;
    departureTime: string;
    arrivalTime: string;
    summary: string[];
  };
  sessionId: string;
  movementHistory?: Array<{ at: string; reason: string; station: { name: string; position: Position }; position: Position; previousStationName?: string }>;
  cards?: { played: string[]; discarded: string[]; remainingHand: string[] };
  elapsedHidingSeconds?: number;
  timeBonusMinutes?: number;
  pausedSeconds?: number;
  pauseCount?: number;
  questionsAsked?: number;
  xenoVetoes?: number;
  randomizations?: number;
};

export type SoloClientSession = {
  token: string;
  cardsDrawn: number;
  cardsKept: number;
  questionUses: Record<string, number>;
  hidingTimeMinutes: number;
  stationZoneMiles: number;
  phase: SoloPhase;
  departureTime: string;
  createdAt: string;
  startPosition: Position;
  pausedAt?: string;
  totalPausedSeconds?: number;
  pauseCount?: number;
  questions: Record<string, SoloQuestionRecord>;
  humanState: SharedState;
  boardState: SharedState;
  reveal?: SoloReveal;
  cardState?: SoloPublicCardState;
};

export type SoloStartResponse = Pick<SoloClientSession, 'token' | 'cardsDrawn' | 'cardsKept' | 'questionUses' | 'hidingTimeMinutes' | 'stationZoneMiles' | 'phase' | 'departureTime' | 'createdAt' | 'startPosition' | 'pausedAt' | 'totalPausedSeconds' | 'pauseCount' | 'cardState'>;

export function elapsedSoloSeconds(
  session: Pick<SoloClientSession, 'createdAt' | 'pausedAt' | 'totalPausedSeconds'>,
  now = Date.now(),
) {
  const end = session.pausedAt ? Date.parse(session.pausedAt) : now;
  return Math.max(0, Math.floor((end - Date.parse(session.createdAt)) / 1000) - (session.totalPausedSeconds ?? 0));
}

export function formatElapsedTime(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remainder = safe % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

export function canonicalQuestionKey(constraint: Pick<Constraint, 'kind' | 'distanceMiles' | 'category'>) {
  if (constraint.kind === 'radar' || constraint.kind === 'thermometer') {
    const distance = Number(constraint.distanceMiles);
    const prescribed = RULEBOOK_DISTANCE_CHOICES[constraint.kind].some((candidate) => candidate === distance);
    return `${constraint.kind}:${prescribed ? distance.toFixed(3) : 'custom'}`;
  }
  return `${constraint.kind}:${constraint.category ?? 'default'}`;
}

export function normalizeQuestionUses(questionUses: Record<string, number>) {
  return Object.entries(questionUses).reduce<Record<string, number>>((normalized, [key, uses]) => {
    const [kind, value] = key.split(':', 2);
    const distance = Number(value);
    const normalizedKey = (kind === 'radar' || kind === 'thermometer') && value !== 'custom' && Number.isFinite(distance)
      ? canonicalQuestionKey({ kind, distanceMiles: distance })
      : key;
    normalized[normalizedKey] = (normalized[normalizedKey] ?? 0) + uses;
    return normalized;
  }, {});
}

export function questionUseCounts(constraints: Array<Pick<Constraint, 'kind' | 'distanceMiles' | 'category'>>) {
  return constraints.reduce<Record<string, number>>((counts, constraint) => {
    const key = canonicalQuestionKey(constraint);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

export function askedChoiceLabel(label: string, uses: number) {
  return uses > 0 ? `${label} · asked ${uses}x` : label;
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
    const base = key === 'photo-reference:you' ? 0 : QUESTION_DEFINITIONS[kind]?.baseKeepCount ?? 0;
    return total + base * uses * (uses + 1) / 2;
  }, 0);
}

export function stationDifficulty(durationSeconds: number, nearbyStations: number, hidingTimeSeconds = 1800) {
  const durationScore = Math.max(0, Math.min(1, durationSeconds / hidingTimeSeconds));
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
  source: SoloPhotoLocation;
  displayText: string;
  heading: number;
  pitch: number;
  fov: number;
  unavailableReason?: string;
  rewardEligible?: boolean;
  staticAssetUrl?: string;
  generatedAsset?: 'street-orientation';
};

const normalizedHeading = (heading: number) => ((heading % 360) + 360) % 360;

export function soloPhotoPlan(
  kind: AnySoloPhotoKind,
  _spot: Position,
  _station: Position,
  _cardinalDirection: Constraint['direction'] = 'north',
  seededHeading = 0,
): SoloPhotoPlan {
  const atSpot = (displayText: string, heading: number, pitch: number, fov: number): SoloPhotoPlan => ({
    source: 'spot', displayText, heading: normalizedHeading(heading), pitch, fov,
  });
  const atStation = (displayText: string, heading: number, pitch: number, fov: number): SoloPhotoPlan => ({
    source: 'station', displayText, heading: normalizedHeading(heading), pitch, fov,
  });
  const inZone = (displayText: string, heading: number, fov: number): SoloPhotoPlan => ({
    source: 'zone', displayText, heading: normalizedHeading(heading), pitch: 0, fov,
  });
  const unavailable = (reason: string, rewardEligible = false): SoloPhotoPlan => ({
    source: SOLO_PHOTO_LOCATIONS[kind], displayText: `I cannot answer: ${reason}`, heading: normalizedHeading(seededHeading), pitch: 0, fov: 90,
    unavailableReason: reason, rewardEligible,
  });

  if (kind === 'any-building-visible-from-station') {
    return atStation('Any building visible from station · Street View approximation at the central station', seededHeading, 8, 90);
  }
  if (kind === 'tallest-building-visible-from-station') {
    return atStation('Tallest building visible from station · Street View approximation at the central station', seededHeading + 180, 14, 75);
  }
  if (kind === 'widest-street') {
    return inZone('Widest street · Solo house rule: another street elsewhere in the hiding zone, not necessarily the widest', seededHeading + 90, 120);
  }
  if (kind === 'a-tree') {
    return inZone('A tree · best-effort park view elsewhere in the hiding zone', seededHeading, 75);
  }
  if (kind === 'tallest-structure-in-your-sightline') {
    return atSpot('Tallest structure in your sightline · Street View approximation at the hiding location', seededHeading + 180, 14, 75);
  }
  if (kind === 'the-sky') {
    return atSpot('The sky · Street View at the hiding location', seededHeading, 90, 90);
  }
  if (kind === 'two-buildings') {
    return inZone('Two buildings · Street View framing approximation elsewhere in the hiding zone', seededHeading + 270, 120);
  }
  if (kind === 'you') return {
    source: 'static',
    displayText: 'You · Xeno selfie (identity successfully concealed)',
    heading: normalizedHeading(seededHeading),
    pitch: 0,
    fov: 90,
    staticAssetUrl: '/solo-selfie.svg',
  };
  if (kind === 'trace-nearest-street-path') return {
    ...atSpot('Trace nearest street/path · approximate nearest named-street orientation; north is up', seededHeading, 0, 90),
    generatedAsset: 'street-orientation',
  };
  if (kind === 'restaurant-interior') return inZone('Restaurant interior · best-effort through-window view elsewhere in the hiding zone', seededHeading, 100);
  if (kind === 'park') return inZone('Park · outdoor Street View elsewhere in the hiding zone', seededHeading, 90);
  if (kind === 'grocery-store-aisle') return inZone('Grocery-store aisle · best-effort view elsewhere in the hiding zone', seededHeading, 100);
  if (kind === 'place-of-worship') return inZone('Place of worship · best-effort view elsewhere in the hiding zone', seededHeading, 100);
  if (kind === 'train-platform') return inZone('Train platform · best-effort view elsewhere in the hiding zone', seededHeading, 100);
  return unavailable('Unsupported photo card');
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
    stationZoneMiles: base.stationZoneMiles,
    transitScope: base.transitScope,
    stationStatuses: {},
    routeStatuses: {},
    hiderPosition: undefined,
    hiderMapUrl: undefined,
    endGameActive: false,
    manualReachBoundary: base.manualReachBoundary
      ? { ...base.manualReachBoundary, enabled: false }
      : undefined,
  };
}

export function soloRevealMapFeatures(reveal: Pick<SoloReveal, 'station' | 'spot'>) {
  return [
    turf.point(
      [reveal.station.position.lng, reveal.station.position.lat],
      { kind: 'solo-reveal-station', areaName: `Central station: ${reveal.station.name}` },
    ),
    turf.point([reveal.spot.lng, reveal.spot.lat], { kind: 'solo-reveal', areaName: 'Xeno hiding spot' }),
  ];
}
