import { distanceMeters } from '../../src/solo';
import type { Position } from '../../src/types';
import { jsonError, readJson, seal, unseal, type SecretSoloSession } from '../_solo-session';
import { revealPayload } from '../_solo-reveal';
import { publicCardState } from '../_solo-cards';

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
      const cardState = publicCardState(session);
      return Response.json({ token: await seal(session), phase: session.phase, cardState, reveal: await revealPayload(session, session.phase === 'found' ? 'found' : 'gave-up') }, { headers: { 'cache-control': 'no-store' } });
    }
    const spotDistance = distanceMeters(body.position, session.spot);
    if (spotDistance <= 30) {
      session.phase = 'found';
      const cardState = publicCardState(session);
      return Response.json({
        token: await seal(session), phase: session.phase, message: 'You found Xeno.',
        reveal: await revealPayload(session, 'found'),
        cardState,
      }, { headers: { 'cache-control': 'no-store' } });
    }
    const stationDistance = distanceMeters(body.position, session.station.position);
    if (stationDistance <= 0.25 * 1609.344) {
      session.phase = 'end-game';
      const cardState = publicCardState(session);
      return Response.json({
        token: await seal(session), phase: session.phase,
        message: 'You are inside the hiding zone. The end game has begun.',
        cardState,
      }, { headers: { 'cache-control': 'no-store' } });
    }
    const cardState = publicCardState(session);
    return Response.json({ token: await seal(session), phase: session.phase, cardState, message: 'Not found yet.' }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Could not check that location.', 400);
  }
}
