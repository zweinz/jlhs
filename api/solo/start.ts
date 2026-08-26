import { SF_BOUNDS } from '../../src/data';
import { jsonError, readJson, seal } from '../_solo-session';
import { initializeCardSession, publicCardState } from '../_solo-cards';
import { chooseSoloHidingLocation } from '../_solo-location';
import type { Position, TransitScope } from '../../src/types';

export const config = { runtime: 'edge' };

type StartBody = {
  origin?: Position;
  departureTime?: string;
  transitScope?: TransitScope;
  hidingTimeMinutes?: number;
  stationZoneMiles?: number;
};

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
    const transitScope = body.transitScope ?? 'all';
    if (transitScope !== 'all' && transitScope !== 'primary') return jsonError('Choose a valid transit game scope.');
    const hidingTimeMinutes = body.hidingTimeMinutes ?? 30;
    if (!Number.isFinite(hidingTimeMinutes) || hidingTimeMinutes < 5 || hidingTimeMinutes > 180) {
      return jsonError('Hiding time must be between 5 and 180 minutes.');
    }
    const stationZoneMiles = body.stationZoneMiles ?? 0.25;
    if (!Number.isFinite(stationZoneMiles) || stationZoneMiles < 0.05 || stationZoneMiles > 5) {
      return jsonError('Hiding-zone radius must be between 0.05 and 5 miles.');
    }
    const departure = new Date(body.departureTime ?? '');
    if (!Number.isFinite(departure.getTime())) return jsonError('Choose a valid date and time.');
    const ageDays = (departure.getTime() - Date.now()) / 86_400_000;
    if (ageDays < -7 || ageDays > 100) return jsonError('Transit time must be within 7 days in the past or 100 days in the future.');

    const chosen = await chooseSoloHidingLocation(
      body.origin!, departure.toISOString(), hidingTimeMinutes * 60, transitScope, stationZoneMiles,
    );
    if (!chosen) return jsonError('Reachable stations did not have enough outdoor Street View coverage. Try another start time or location.', 422);

    const now = new Date();
    const headingSeed = crypto.getRandomValues(new Uint32Array(1))[0];
    const session = initializeCardSession({
      kind: 'solo-session',
      version: 2,
      sessionId: crypto.randomUUID(),
      createdAt: now.toISOString(),
      startPosition: body.origin!,
      expiresAt: new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString(),
      departureTime: departure.toISOString(),
      transitScope,
      hidingTimeMinutes,
      stationZoneMiles,
      phase: 'seeking',
      cardsDrawn: 0,
      cardsKept: 0,
      questionUses: {},
      wideHeading: headingSeed % 360,
      station: { id: chosen.station.id, name: chosen.station.name, position: { lat: chosen.station.lat, lng: chosen.station.lng } },
      spot: chosen.panorama.position,
      panorama: { id: chosen.panorama.id, date: chosen.panorama.date },
      stationPanorama: { id: chosen.stationPanorama.id, date: chosen.stationPanorama.date },
      route: chosen.route,
    });
    const cardState = publicCardState(session);
    return Response.json({
      token: await seal(session),
      cardsDrawn: 0,
      cardsKept: 0,
      questionUses: session.questionUses,
      hidingTimeMinutes: session.hidingTimeMinutes,
      stationZoneMiles: session.stationZoneMiles,
      phase: session.phase,
      departureTime: session.departureTime,
      createdAt: session.createdAt,
      startPosition: session.startPosition,
      totalPausedSeconds: 0,
      pauseCount: 0,
      cardState,
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Could not start the Solo game.', 502);
  }
}
