import type { Position, TransitScope } from '../src/types';
import { choosePanorama, panoramasInZone, reachableStations, verifyTransitRoute, weightedTake } from './_solo-google';
import type { SecretSoloSession } from './_solo-session';

export async function chooseSoloHidingLocation(
  origin: Position,
  departureTime: string,
  maxDurationSeconds = 1800,
  transitScope: TransitScope = 'all',
  stationZoneMiles = 0.25,
) {
  const candidates = await reachableStations(origin, departureTime, transitScope, maxDurationSeconds);
  let chosen: {
    station: (typeof candidates)[number]['station'];
    route: SecretSoloSession['route'];
    panorama: Awaited<ReturnType<typeof panoramasInZone>>['panoramas'][number];
    stationPanorama: NonNullable<Awaited<ReturnType<typeof panoramasInZone>>['stationPanorama']>;
  } | undefined;
  while (candidates.length > 0 && !chosen) {
    const candidate = weightedTake(candidates);
    const route = await verifyTransitRoute(origin, candidate.station, departureTime, maxDurationSeconds);
    if (!route || route.durationSeconds > maxDurationSeconds) continue;
    const coverage = await panoramasInZone(candidate.station, stationZoneMiles);
    if (!coverage.stationPanorama || coverage.panoramas.length < 3) continue;
    const panorama = choosePanorama(coverage.panoramas, candidate.station, stationZoneMiles);
    if (panorama) chosen = { station: candidate.station, route, panorama, stationPanorama: coverage.stationPanorama };
  }
  return chosen;
}
