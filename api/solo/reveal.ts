import { jsonError, readJson, seal, unseal, type SecretSoloSession } from '../_solo-session';
import { revealPayload } from '../_solo-reveal';

export const config = { runtime: 'edge' };
type RevealBody = { token?: string };

export default async function handler(request: Request) {
  if (request.method !== 'POST') return jsonError('Use POST to reveal a Solo game.', 405);
  try {
    const body = await readJson<RevealBody>(request);
    if (!body.token) return jsonError('Solo session token is required.');
    const session = await unseal<SecretSoloSession>(body.token, 'solo-session');
    session.phase = session.phase === 'found' ? 'found' : 'gave-up';
    return Response.json({
      token: await seal(session), phase: session.phase,
      reveal: await revealPayload(session, session.phase === 'found' ? 'found' : 'gave-up'),
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Could not reveal the Solo location.', 400);
  }
}
