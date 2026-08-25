import { SF_BOUNDS } from '../../src/data';
import { choosePanorama, panoramasInZone, reachableStations, verifyTransitRoute, weightedTake } from '../_solo-google';
import { commitmentFor, jsonError, readJson, seal, type SecretSoloSession } from '../_solo-session';
import type { Position } from '../../src/types';

export const config = { runtime: 'edge' };

type StartBody = { origin?: Position; departureTime?: string };

function validPosition(position?: Position) {
  return !!position && Number.isFinite(position.lat) && Number.isFinite(position.lng) &&
    position.lat >= SF_BOUNDS.south && position.lat <= SF_BOUNDS.north &&
    position.lng >= SF_BOUNDS.west && position.lng <= SF_BOUNDS.east;
}

export default async function handler(request: Request) {
  if (request.method !== 'POST') return jsonError('Use POST to start a Solo game.', 405);
  try {
    const body = await readJson<StartBody>(request);
    if (!validPosition(body.origin)) return jsonError('Choose a starting location inside San Francisco.');
    const departure = new Date(body.departureTime ?? '');
    if (!Number.isFinite(departure.getTime())) return jsonError('Choose a valid date and time.');
    const ageDays = (departure.getTime() - Date.now()) / 86_400_000;
    if (ageDays < -7 || ageDays > 100) return jsonError('Transit time must be within 7 days in the past or 100 days in the future.');

    const candidates = await reachableStations(body.origin!, departure.toISOString());
    if (candidates.length === 0) return jsonError('No valid station can be reached by transit within 30 minutes from that start.', 422);

    let chosen: {
      station: (typeof candidates)[number]['station'];
      route: SecretSoloSession['route'];
      panorama: Awaited<ReturnType<typeof panoramasInZone>>['panoramas'][number];
      stationPanorama: NonNullable<Awaited<ReturnType<typeof panoramasInZone>>['stationPanorama']>;
    } | undefined;
    while (candidates.length > 0 && !chosen) {
      const candidate = weightedTake(candidates);
      const route = await verifyTransitRoute(body.origin!, candidate.station, departure.toISOString());
      if (!route) continue;
      const coverage = await panoramasInZone(candidate.station);
      if (!coverage.stationPanorama || coverage.panoramas.length < 3) continue;
      const panorama = choosePanorama(coverage.panoramas, candidate.station);
      if (panorama) chosen = { station: candidate.station, route, panorama, stationPanorama: coverage.stationPanorama };
    }
    if (!chosen) return jsonError('Reachable stations did not have enough outdoor Street View coverage. Try another start time or location.', 422);

    const now = new Date();
    const random = crypto.getRandomValues(new Uint8Array(18));
    const salt = Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const session: SecretSoloSession = {
      kind: 'solo-session',
      version: 1,
      sessionId: crypto.randomUUID(),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString(),
      departureTime: departure.toISOString(),
      salt,
      commitment: '',
      commitmentVersion: 2,
      phase: 'seeking',
      cardsDrawn: 0,
      cardsKept: 0,
      questionUses: {},
      wideHeading: Number.parseInt(salt.slice(0, 8), 16) % 360,
      station: { id: chosen.station.id, name: chosen.station.name, position: { lat: chosen.station.lat, lng: chosen.station.lng } },
      spot: chosen.panorama.position,
      panorama: { id: chosen.panorama.id, date: chosen.panorama.date },
      stationPanorama: { id: chosen.stationPanorama.id, date: chosen.stationPanorama.date },
      route: chosen.route,
    };
    session.commitment = await commitmentFor(session);
    return Response.json({
      token: await seal(session),
      commitment: session.commitment,
      cardsDrawn: 0,
      cardsKept: 0,
      phase: session.phase,
      departureTime: session.departureTime,
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Could not start the Solo game.', 502);
  }
}
