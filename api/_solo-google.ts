import * as turf from '@turf/turf';
import { SF_BOUNDS } from '../src/data';
import { nearbyStationCount, stationDifficulty } from '../src/solo';
import { validStations } from '../src/transit';
import type { Position } from '../src/types';
import type { SecretSoloSession } from './_solo-session';

declare const process: { env: Record<string, string | undefined> };

type MatrixElement = {
  destinationIndex?: number;
  duration?: string;
  distanceMeters?: number;
  condition?: string;
  status?: { code?: number; message?: string };
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
  if (!response.ok) throw new Error(`Google Routes matrix failed (${response.status}).`);
  return response.json() as Promise<MatrixElement[]>;
}

export async function reachableStations(origin: Position, departureTime: string) {
  const stationBatches = chunk(validStations, 100);
  const matrices = await Promise.all(stationBatches.map((batch) => routeMatrix(origin, batch, departureTime)));
  return matrices.flatMap((elements, batchIndex) => elements.flatMap((element) => {
    const localIndex = element.destinationIndex;
    if (localIndex === undefined || element.status?.code || element.condition === 'ROUTE_NOT_FOUND') return [];
    const station = stationBatches[batchIndex][localIndex];
    const durationSeconds = parseSeconds(element.duration);
    if (!station || !Number.isFinite(durationSeconds) || durationSeconds > 1800) return [];
    const nearby = nearbyStationCount(station, validStations);
    return [{ station, durationSeconds, distanceMeters: element.distanceMeters ?? 0, score: stationDifficulty(durationSeconds, nearby) }];
  })).sort((a, b) => b.score - a.score).slice(0, 12);
}

export async function verifyTransitRoute(origin: Position, destination: Position, departureTime: string) {
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
  if (!Number.isFinite(durationSeconds) || durationSeconds > 1800 || !steps.some((step) => step.travelMode === 'TRANSIT')) return null;
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

function candidatePoints(station: Position) {
  return [station, ...[0.12, 0.22].flatMap((radius) =>
    Array.from({ length: 8 }, (_, index) => {
      const point = turf.destination([station.lng, station.lat], radius, index * 45, { units: 'miles' });
      return { lat: point.geometry.coordinates[1], lng: point.geometry.coordinates[0] };
    }),
  )];
}

async function panoramaAt(position: Position) {
  const url = new URL('https://maps.googleapis.com/maps/api/streetview/metadata');
  url.searchParams.set('location', `${position.lat},${position.lng}`);
  url.searchParams.set('radius', '50');
  url.searchParams.set('source', 'outdoor');
  url.searchParams.set('key', serverKey());
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) return null;
  const metadata = (await response.json()) as PanoramaMetadata;
  if (metadata.status !== 'OK' || !metadata.pano_id || !metadata.location) return null;
  const { lat, lng } = metadata.location;
  if (lat < SF_BOUNDS.south || lat > SF_BOUNDS.north || lng < SF_BOUNDS.west || lng > SF_BOUNDS.east) return null;
  return { id: metadata.pano_id, date: metadata.date, position: metadata.location };
}

export async function panoramasInZone(station: Position) {
  const results = await Promise.all(candidatePoints(station).map(panoramaAt));
  const byId = new Map<string, NonNullable<(typeof results)[number]>>();
  results.forEach((panorama) => {
    if (!panorama) return;
    const miles = turf.distance([station.lng, station.lat], [panorama.position.lng, panorama.position.lat], { units: 'miles' });
    if (miles <= 0.25) byId.set(panorama.id, panorama);
  });
  return [...byId.values()];
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

export function choosePanorama<T extends { position: Position }>(panoramas: T[], station: Position) {
  const weighted = panoramas.map((panorama) => {
    const miles = turf.distance([station.lng, station.lat], [panorama.position.lng, panorama.position.lat], { units: 'miles' });
    const edgeWeight = miles >= 0.15 && miles <= 0.24 ? 6 : 1 + Math.min(4, miles * 16);
    return { panorama, score: edgeWeight };
  });
  return weightedTake(weighted)?.panorama;
}
