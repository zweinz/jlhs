import { distanceMeters } from '../../src/solo';
import type { Position } from '../../src/types';
import { jsonError, readJson, seal, unseal, type SecretSoloSession } from '../_solo-session';
import { revealPayload } from '../_solo-reveal';

export const config = { runtime: 'edge' };
type CheckBody = { token?: string; position?: Position };

export default async function handler(request: Request) {
  if (request.method !== 'POST') return jsonError('Use POST to check a Solo location.', 405);
  try {
    const body = await readJson<CheckBody>(request);
    if (!body.token || !body.position || !Number.isFinite(body.position.lat) || !Number.isFinite(body.position.lng)) {
      return jsonError('A current position is required.');
    }
    const session = await unseal<SecretSoloSession>(body.token, 'solo-session');
    if (session.phase === 'found' || session.phase === 'gave-up') {
      return Response.json({ token: body.token, phase: session.phase, reveal: await revealPayload(session, session.phase === 'found' ? 'found' : 'gave-up') });
    }
    const spotDistance = distanceMeters(body.position, session.spot);
    if (spotDistance <= 30) {
      session.phase = 'found';
      return Response.json({
        token: await seal(session), phase: session.phase, message: 'You found the AI hider.',
        reveal: await revealPayload(session, 'found'),
      }, { headers: { 'cache-control': 'no-store' } });
    }
    const stationDistance = distanceMeters(body.position, session.station.position);
    if (stationDistance <= 0.25 * 1609.344) {
      session.phase = 'end-game';
      return Response.json({
        token: await seal(session), phase: session.phase,
        message: 'You are inside the hiding zone. The end game has begun.',
      }, { headers: { 'cache-control': 'no-store' } });
    }
    return Response.json({ token: await seal(session), phase: session.phase, message: 'Not found yet.' }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Could not check that location.', 400);
  }
}
