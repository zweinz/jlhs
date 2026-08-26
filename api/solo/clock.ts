import { pauseSession, publicClock, resumeSession } from '../_solo-clock';
import { jsonError, readJson, seal, unseal, type SecretSoloSession } from '../_solo-session';
import { publicCardState } from '../_solo-cards';

export const config = { runtime: 'edge' };

type ClockBody = { token?: string; action?: 'pause' | 'resume' };

export default async function handler(request: Request) {
  if (request.method !== 'POST') return jsonError('Use POST for the Solo timer.', 405);
  try {
    const body = await readJson<ClockBody>(request);
    if (!body.token || (body.action !== 'pause' && body.action !== 'resume')) return jsonError('Choose pause or resume.');
    const session = await unseal<SecretSoloSession>(body.token, 'solo-session');
    const changed = body.action === 'pause' ? pauseSession(session) : resumeSession(session);
    if (!changed) return jsonError(body.action === 'pause' ? 'The Solo timer is already paused or the game has ended.' : 'The Solo timer is already running.', 409);
    return Response.json({
      token: await seal(session),
      phase: session.phase,
      clock: publicClock(session),
      cardState: publicCardState(session),
      message: body.action === 'pause' ? 'Game timer paused.' : 'Game timer resumed.',
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Could not update the Solo timer.', 400);
  }
}
