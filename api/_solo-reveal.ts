import { seal, type PhotoAsset, type SecretSoloSession } from './_solo-session';
import { finalTimeBonusMinutes, publicCardNames } from './_solo-cards';
import { activeElapsedSeconds } from './_solo-clock';

export async function revealPayload(session: SecretSoloSession, reason: 'found' | 'gave-up' | 'peek') {
  const asset: PhotoAsset = {
    kind: 'solo-photo', version: 1, expiresAt: session.expiresAt,
    panoramaId: session.panorama.id, heading: session.wideHeading, pitch: 0, fov: 120,
  };
  const elapsedHidingSeconds = activeElapsedSeconds(session);
  return {
    reason,
    station: session.station,
    spot: session.spot,
    panorama: { ...session.panorama, imageUrl: `/api/solo/photo?token=${encodeURIComponent(await seal(asset))}` },
    stationPanorama: session.stationPanorama,
    route: session.route,
    sessionId: session.sessionId,
    movementHistory: session.movementHistory,
    cards: {
      played: publicCardNames(session.deck.usedPile),
      discarded: publicCardNames(session.deck.discardPile),
      remainingHand: publicCardNames(session.deck.hand),
    },
    elapsedHidingSeconds,
    timeBonusMinutes: finalTimeBonusMinutes(session),
    pausedSeconds: session.totalPausedSeconds ?? 0,
    pauseCount: session.pauseCount ?? 0,
    questionsAsked: session.questionNumber ?? 0,
    xenoVetoes: session.xenoVetoes ?? 0,
    randomizations: session.randomizations ?? 0,
  };
}
