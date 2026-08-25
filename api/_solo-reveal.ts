import { seal, type PhotoAsset, type SecretSoloSession } from './_solo-session';

export async function revealPayload(session: SecretSoloSession, reason: 'found' | 'gave-up') {
  const asset: PhotoAsset = {
    kind: 'solo-photo', version: 1, expiresAt: session.expiresAt,
    panoramaId: session.panorama.id, heading: session.wideHeading, pitch: 0, fov: 120,
  };
  return {
    reason,
    station: session.station,
    spot: session.spot,
    panorama: { ...session.panorama, imageUrl: `/api/solo/photo?token=${encodeURIComponent(await seal(asset))}` },
    stationPanorama: session.stationPanorama,
    commitmentVersion: session.commitmentVersion,
    route: session.route,
    sessionId: session.sessionId,
    salt: session.salt,
    commitment: session.commitment,
  };
}
