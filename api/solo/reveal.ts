import { jsonError, readJson, seal, unseal, type SecretSoloSession } from '../_solo-session';
import { revealPayload } from '../_solo-reveal';
import { publicCardState } from '../_solo-cards';

export const config = { runtime: 'edge' };
type RevealBody = { token?: string; resign?: boolean };

export default async function handler(request: Request) {
  if (request.method !== 'POST') return jsonError('Use POST to reveal a Solo game.', 405);
  try {
    const body = await readJson<RevealBody>(request);
    if (!body.token) return jsonError('Solo session token is required.');
    const session = await unseal<SecretSoloSession>(body.token, 'solo-session');
    if (body.resign && session.phase !== 'found') session.phase = 'gave-up';
    const reason = session.phase === 'found' ? 'found' : session.phase === 'gave-up' ? 'gave-up' : 'peek';
    const cardState = publicCardState(session);
    return Response.json({
      token: await seal(session), phase: session.phase,
      reveal: await revealPayload(session, reason),
      cardState,
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Could not reveal the Solo location.', 400);
  }
}
