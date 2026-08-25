import * as turf from '@turf/turf';
import { pois, SF_BOUNDS } from '../src/data';
import { nearbyStationCount, stationDifficulty } from '../src/solo';
import { primaryTransitStationIds, validStations } from '../src/transit';
import type { Position, TransitScope } from '../src/types';
import type { SecretSoloSession } from './_solo-session';

declare const process: { env: Record<string, string | undefined> };

type MatrixElement = {
  destinationIndex?: number;
  duration?: string;
  distanceMeters?: number;
  condition?: string;
  status?: { code?: number; message?: string };
  error?: { code?: number; message?: string; status?: string };
};

type RouteResponse = {
  routes?: Array<{
    duration?: string;
    distanceMeters?: number;
    legs?: Array<{ steps?: Array<{
      travelMode?: string;
      transitDetails?: { transitLine?: { name?: string; nameShort?: string }; headsign?: string };
    }> }>;
  }>;
};

type PanoramaMetadata = {
  status?: string;
  pano_id?: string;
  date?: string;
  location?: Position;
};

export const chunk = <T,>(items: T[], size: number) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

const parseSeconds = (value?: string) => Number(value?.replace(/s$/, '') ?? Number.NaN);

function serverKey() {
  const key = process.env.GOOGLE_MAPS_SERVER_API_KEY;
  if (!key) throw new Error('GOOGLE_MAPS_SERVER_API_KEY is not configured.');
  return key;
}

function routeHeaders(fieldMask: string) {
  return {
    'content-type': 'application/json',
    'x-goog-api-key': serverKey(),
    'x-goog-fieldmask': fieldMask,
  };
}

async function routeMatrix(origin: Position, destinations: Position[], departureTime: string) {
  const response = await fetch('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', {
    method: 'POST',
    headers: routeHeaders('originIndex,destinationIndex,duration,distanceMeters,status,condition'),
    body: JSON.stringify({
      origins: [{ waypoint: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } } }],
      destinations: destinations.map((position) => ({
        waypoint: { location: { latLng: { latitude: position.lat, longitude: position.lng } } },
      })),
      travelMode: 'TRANSIT',
      departureTime,
    }),
  });
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json() as { error?: { message?: string } };
      detail = body.error?.message?.replace(/\s+/g, ' ').trim().slice(0, 240) ?? '';
    } catch {
      // Google did not return its usual JSON error envelope.
    }
    if (response.status === 429) {
      throw new Error('Google Routes quota is temporarily exhausted. Try again in one minute; if this continues, the configured daily limit has been reached.');
    }
    throw new Error(`Google Routes matrix failed (${response.status})${detail ? `: ${detail}` : ''}.`);
  }
  return response.json() as Promise<MatrixElement[]>;
}

function matrixServiceError(elements: MatrixElement[]) {
  const streamError = elements.find((element) => element.error?.code)?.error;
  const failures = elements.filter((element) => element.status?.code);
  const hasUsableElement = elements.some((element) =>
    !element.status?.code && element.condition !== 'ROUTE_NOT_FOUND' && Number.isFinite(parseSeconds(element.duration)),
  );
  if (hasUsableElement) return null;
  if (streamError?.code === 429 || streamError?.status === 'RESOURCE_EXHAUSTED') {
    return new Error('Google Routes quota is temporarily exhausted. Try again in one minute; if this continues, the configured daily limit has been reached.');
  }
  if (failures.length === 0) return null;
  const code = failures[0].status?.code;
  if (code === 8) {
    return new Error('Google Routes quota is temporarily exhausted. Try again in one minute; if this continues, the configured daily limit has been reached.');
  }
  const detail = failures[0].status?.message?.replace(/\s+/g, ' ').trim().slice(0, 240);
  return new Error(`Google Routes could not calculate station travel times${detail ? `: ${detail}` : ` (status ${code})`}.`);
}

export async function reachableStations(
  origin: Position,
  departureTime: string,
  transitScope: TransitScope = 'all',
  maxDurationSeconds = 1800,
) {
  const primaryIds = new Set(primaryTransitStationIds);
  const stationPool = transitScope === 'primary'
    ? validStations.filter((station) => primaryIds.has(station.id))
    : validStations;
  const stationBatches = chunk(stationPool, 100);
  const matrices: Array<{ stations: typeof validStations; elements: MatrixElement[] }> = [];
  const requestErrors: Error[] = [];
  for (const stations of stationBatches) {
    try {
      matrices.push({ stations, elements: await routeMatrix(origin, stations, departureTime) });
    } catch (error) {
      requestErrors.push(error instanceof Error ? error : new Error('Google Routes could not calculate station travel times.'));
    }
  }
  const hasUsableElement = matrices.some(({ elements }) => elements.some((element) =>
    !element.status?.code && element.condition !== 'ROUTE_NOT_FOUND' && Number.isFinite(parseSeconds(element.duration)),
  ));
  if (!hasUsableElement && requestErrors.length > 0) {
    throw requestErrors.find((error) => /quota/i.test(error.message)) ?? requestErrors[0];
  }
  const serviceError = matrixServiceError(matrices.flatMap(({ elements }) => elements));
  if (serviceError) throw serviceError;
  return matrices.flatMap(({ stations, elements }) => elements.flatMap((element) => {
    const localIndex = element.destinationIndex;
    if (localIndex === undefined || element.status?.code || element.condition === 'ROUTE_NOT_FOUND') return [];
    const station = stations[localIndex];
    const durationSeconds = parseSeconds(element.duration);
    if (!station || !Number.isFinite(durationSeconds) || durationSeconds > maxDurationSeconds) return [];
    const nearby = nearbyStationCount(station, stationPool);
    return [{ station, durationSeconds, distanceMeters: element.distanceMeters ?? 0, score: stationDifficulty(durationSeconds, nearby, maxDurationSeconds) }];
  })).sort((a, b) => b.score - a.score).slice(0, 12);
}

export async function verifyTransitRoute(
  origin: Position,
  destination: Position,
  departureTime: string,
  maxDurationSeconds = 1800,
) {
  const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: routeHeaders('routes.duration,routes.distanceMeters,routes.legs.steps.travelMode,routes.legs.steps.transitDetails'),
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
      destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
      travelMode: 'TRANSIT',
      departureTime,
    }),
  });
  if (!response.ok) return null;
  const route = ((await response.json()) as RouteResponse).routes?.[0];
  const durationSeconds = parseSeconds(route?.duration);
  const steps = route?.legs?.flatMap((leg) => leg.steps ?? []) ?? [];
  const transitSteps = steps.filter((step) => step.travelMode === 'TRANSIT');
  if (!Number.isFinite(durationSeconds) || durationSeconds > maxDurationSeconds || transitSteps.length === 0) return null;
  const summary = steps.flatMap((step) => {
    if (step.travelMode === 'WALK') return ['Walk'];
    const line = step.transitDetails?.transitLine;
    if (step.travelMode === 'TRANSIT') return [line?.nameShort || line?.name || step.transitDetails?.headsign || 'Public transit'];
    return [];
  }).filter((value, index, values) => values[index - 1] !== value);
  const arrivalTime = new Date(Date.parse(departureTime) + durationSeconds * 1000).toISOString();
  return {
    durationSeconds,
    distanceMeters: route?.distanceMeters ?? 0,
    departureTime,
    arrivalTime,
    summary,
  } satisfies SecretSoloSession['route'];
}

function candidatePoints(station: Position, stationZoneMiles = 0.25) {
  return [station, ...[stationZoneMiles * 0.48, stationZoneMiles * 0.88].flatMap((radius) =>
    Array.from({ length: 8 }, (_, index) => {
      const point = turf.destination([station.lng, station.lat], radius, index * 45, { units: 'miles' });
      return { lat: point.geometry.coordinates[1], lng: point.geometry.coordinates[0] };
    }),
  )];
}

export async function panoramaAt(position: Position, source: 'outdoor' | 'any' = 'outdoor') {
  const url = new URL('https://maps.googleapis.com/maps/api/streetview/metadata');
  url.searchParams.set('location', `${position.lat},${position.lng}`);
  url.searchParams.set('radius', '50');
  if (source === 'outdoor') url.searchParams.set('source', 'outdoor');
  url.searchParams.set('key', serverKey());
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) return null;
  const metadata = (await response.json()) as PanoramaMetadata;
  if (metadata.status !== 'OK' || !metadata.pano_id || !metadata.location) return null;
  const { lat, lng } = metadata.location;
  if (lat < SF_BOUNDS.south || lat > SF_BOUNDS.north || lng < SF_BOUNDS.west || lng > SF_BOUNDS.east) return null;
  return { id: metadata.pano_id, date: metadata.date, position: metadata.location };
}

export type PhotoTarget = {
  name?: string;
  panorama?: NonNullable<Awaited<ReturnType<typeof panoramaAt>>>;
  heading?: number;
  displayText?: string;
  unavailableReason?: string;
};

type PhotoTargetKind = 'a-tree' | 'restaurant-interior' | 'park' | 'grocery-store-aisle' | 'place-of-worship' | 'train-platform';
type TargetCandidate = { id: string; name: string; position: Position };
export const TARGETED_PHOTO_KINDS = [
  'a-tree', 'restaurant-interior', 'park', 'grocery-store-aisle', 'place-of-worship', 'train-platform',
] as const satisfies readonly PhotoTargetKind[];

type PlaceTargetSpec = { types: string[]; label: string; minimumReviews?: number };

const placeTargetSpecs: Partial<Record<PhotoTargetKind, PlaceTargetSpec>> = {
  'restaurant-interior': { types: ['restaurant'], label: 'restaurant' },
  park: { types: ['park', 'city_park', 'dog_park'], label: 'qualifying park', minimumReviews: 6 },
  'grocery-store-aisle': {
    types: ['asian_grocery_store', 'convenience_store', 'discount_supermarket', 'grocery_store', 'liquor_store', 'supermarket'],
    label: 'grocery store',
  },
  'place-of-worship': {
    types: ['buddhist_temple', 'church', 'hindu_temple', 'mosque', 'shinto_shrine', 'synagogue'],
    label: 'place of worship',
  },
};

async function nearbyPlaceCandidates(
  station: Position,
  spec: PlaceTargetSpec,
  stationZoneMiles: number,
): Promise<{ candidates: TargetCandidate[]; error?: string }> {
  const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': serverKey(),
      'x-goog-fieldmask': 'places.id,places.displayName,places.location,places.userRatingCount',
    },
    body: JSON.stringify({
      includedTypes: spec.types,
      maxResultCount: 10,
      rankPreference: 'DISTANCE',
      locationRestriction: {
        circle: {
          center: { latitude: station.lat, longitude: station.lng },
          radius: stationZoneMiles * 1609.344,
        },
      },
    }),
  });
  if (!response.ok) {
    return {
      candidates: [],
      error: `Google Places could not search for a ${spec.label} (${response.status}); verify that Places API (New) is enabled for the server key`,
    };
  }
  const body = await response.json() as { places?: Array<{
    id?: string;
    displayName?: { text?: string };
    location?: { latitude?: number; longitude?: number };
    userRatingCount?: number;
  }> };
  const candidates = (body.places ?? []).flatMap((place, index) => {
    const lat = place.location?.latitude;
    const lng = place.location?.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
    const position = { lat: lat!, lng: lng! };
    const miles = turf.distance([station.lng, station.lat], [position.lng, position.lat], { units: 'miles' });
    if (miles > stationZoneMiles || (spec.minimumReviews && (place.userRatingCount ?? 0) < spec.minimumReviews)) return [];
    const name = place.displayName?.text?.replace(/\s+/g, ' ').trim().slice(0, 120) || spec.label;
    return [{ id: place.id ?? `${spec.label}-${index}`, name, position }];
  });
  return { candidates };
}

function localPhotoCandidates(kind: PhotoTargetKind): TargetCandidate[] {
  const category = kind === 'train-platform' ? 'rail-station' : 'dog-park';
  return pois.filter((poi) => poi.category === category).map((poi) => ({
    id: poi.id,
    name: poi.name,
    position: { lat: poi.lat, lng: poi.lng },
  }));
}

function targetDisplayText(kind: PhotoTargetKind) {
  if (kind === 'a-tree') return 'A tree · outdoor Street View aimed into a qualifying park; tree presence is a best-effort approximation';
  if (kind === 'restaurant-interior') return 'Restaurant interior · best-effort through-window or indoor Street View scene';
  if (kind === 'park') return 'Park · outdoor Street View aimed into a qualifying park in the hiding zone';
  if (kind === 'grocery-store-aisle') return 'Grocery-store aisle · best-effort indoor or entrance Street View scene';
  if (kind === 'place-of-worship') return 'Place of worship · best-effort location-matchable Street View scene';
  return 'Train platform · best-effort platform or station Street View scene';
}

export async function photoTargetInZone(
  kind: string | undefined,
  station: Position,
  seededHeading = 0,
  stationZoneMiles = 0.25,
): Promise<PhotoTarget | undefined> {
  if (!kind || !(TARGETED_PHOTO_KINDS as readonly string[]).includes(kind)) {
    return undefined;
  }
  const targetKind = kind as PhotoTargetKind;
  const spec = placeTargetSpecs[targetKind];
  let lookup: { candidates: TargetCandidate[]; error?: string };
  try {
    lookup = spec
      ? await nearbyPlaceCandidates(station, spec, stationZoneMiles)
      : { candidates: localPhotoCandidates(targetKind) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'the place lookup failed';
    return { unavailableReason: `target lookup is unavailable: ${detail}` };
  }
  if (lookup.error) return { unavailableReason: lookup.error };
  const candidates = lookup.candidates
    .map((candidate) => ({
      candidate,
      miles: turf.distance([station.lng, station.lat], [candidate.position.lng, candidate.position.lat], { units: 'miles' }),
    }))
    .filter(({ miles }) => miles <= stationZoneMiles)
    .sort((a, b) => a.miles - b.miles || a.candidate.id.localeCompare(b.candidate.id));
  if (!candidates.length) {
    if (targetKind === 'a-tree') return undefined;
    const label = spec?.label ?? (targetKind === 'park' ? 'qualifying mapped park' : 'mapped rail station');
    return { unavailableReason: `no ${label} exists in this hiding zone` };
  }
  const source = targetKind === 'park' || targetKind === 'a-tree' ? 'outdoor' : 'any';
  for (const { candidate } of candidates) {
    let panorama: Awaited<ReturnType<typeof panoramaAt>>;
    try {
      panorama = await panoramaAt(candidate.position, source);
    } catch {
      panorama = null;
    }
    if (!panorama) continue;
    const panoramaMiles = turf.distance(
      [station.lng, station.lat],
      [panorama.position.lng, panorama.position.lat],
      { units: 'miles' },
    );
    if (panoramaMiles > stationZoneMiles) continue;
    const targetMeters = turf.distance(
      [panorama.position.lng, panorama.position.lat],
      [candidate.position.lng, candidate.position.lat],
      { units: 'kilometers' },
    ) * 1000;
    return {
      name: candidate.name,
      panorama,
      heading: targetMeters < 3 ? seededHeading : turf.bearing(
        turf.point([panorama.position.lng, panorama.position.lat]),
        turf.point([candidate.position.lng, candidate.position.lat]),
      ),
      displayText: targetDisplayText(targetKind),
    };
  }
  if (targetKind === 'a-tree') return undefined;
  const label = spec?.label ?? (targetKind === 'park' ? 'mapped parks' : 'mapped rail stations');
  return { unavailableReason: `${label} exist in this hiding zone, but none has usable Street View inside the zone` };
}

export async function panoramasInZone(station: Position, stationZoneMiles = 0.25) {
  const results = await Promise.all(candidatePoints(station, stationZoneMiles).map((position) => panoramaAt(position)));
  const byId = new Map<string, NonNullable<(typeof results)[number]>>();
  results.forEach((panorama) => {
    if (!panorama) return;
    const miles = turf.distance([station.lng, station.lat], [panorama.position.lng, panorama.position.lat], { units: 'miles' });
    if (miles <= stationZoneMiles) byId.set(panorama.id, panorama);
  });
  return { stationPanorama: results[0], panoramas: [...byId.values()] };
}

function randomUnit() {
  const value = crypto.getRandomValues(new Uint32Array(1))[0];
  return value / 0xffffffff;
}

export function weightedTake<T extends { score: number }>(items: T[]) {
  const total = items.reduce((sum, item) => sum + Math.max(0.001, item.score), 0);
  let cursor = randomUnit() * total;
  const index = items.findIndex((item) => (cursor -= Math.max(0.001, item.score)) <= 0);
  return items.splice(index < 0 ? items.length - 1 : index, 1)[0];
}

export function choosePanorama<T extends { position: Position }>(panoramas: T[], station: Position, stationZoneMiles = 0.25) {
  const weighted = panoramas.flatMap((panorama) => {
    const miles = turf.distance([station.lng, station.lat], [panorama.position.lng, panorama.position.lat], { units: 'miles' });
    if (miles < stationZoneMiles * 0.35 || miles > stationZoneMiles * 0.96) return [];
    const edgeWeight = miles >= stationZoneMiles * 0.6 ? 6 : 1 + Math.min(4, miles * 16 / stationZoneMiles);
    return [{ panorama, score: edgeWeight }];
  });
  return weightedTake(weighted)?.panorama;
}
