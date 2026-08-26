import type { SecretSoloSession } from './_solo-session';

export class SoloPausedError extends Error {}

export function activeElapsedSeconds(session: SecretSoloSession, now = Date.now()) {
  const end = session.endedAt
    ? Date.parse(session.endedAt)
    : session.pausedAt
      ? Date.parse(session.pausedAt)
      : now;
  return Math.max(0, Math.floor((end - Date.parse(session.createdAt)) / 1000) - (session.totalPausedSeconds ?? 0));
}

export function pauseSession(session: SecretSoloSession, now = Date.now()) {
  if (session.pausedAt) return false;
  if (session.endedAt || session.phase === 'found' || session.phase === 'gave-up') return false;
  session.pausedAt = new Date(now).toISOString();
  session.pauseCount = (session.pauseCount ?? 0) + 1;
  return true;
}

export function resumeSession(session: SecretSoloSession, now = Date.now()) {
  if (!session.pausedAt) return false;
  const pausedMilliseconds = Math.max(0, now - Date.parse(session.pausedAt));
  session.totalPausedSeconds = (session.totalPausedSeconds ?? 0) + Math.floor(pausedMilliseconds / 1000);
  session.activeEffects?.forEach((effect) => {
    if (effect.expiresAt) effect.expiresAt = new Date(Date.parse(effect.expiresAt) + pausedMilliseconds).toISOString();
    if (effect.lockedUntil) effect.lockedUntil = new Date(Date.parse(effect.lockedUntil) + pausedMilliseconds).toISOString();
  });
  session.pausedAt = undefined;
  return true;
}

export function finishSessionClock(session: SecretSoloSession, now = Date.now()) {
  if (session.endedAt) return;
  if (session.pausedAt) resumeSession(session, now);
  session.endedAt = new Date(now).toISOString();
}

export function requireRunningSession(session: SecretSoloSession) {
  if (session.pausedAt) throw new SoloPausedError('Resume the Solo timer before continuing.');
}

export function publicClock(session: SecretSoloSession) {
  return {
    createdAt: session.createdAt,
    pausedAt: session.pausedAt,
    totalPausedSeconds: session.totalPausedSeconds ?? 0,
    pauseCount: session.pauseCount ?? 0,
    elapsedSeconds: activeElapsedSeconds(session),
  };
}
