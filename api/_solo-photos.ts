import { nearestStreetOrientation } from '../src/rulebookGeometry';
import { isHidingPositionAllowed } from '../src/noHideZones';
import { distanceMeters, soloPhotoPlan, type SoloPhotoKind, type SoloPhotoPlan } from '../src/solo';
import type { Constraint, Position } from '../src/types';
import { panoramaAt, panoramasInZone, photoTargetInZone, ZONE_PHOTO_SEPARATION_METERS } from './_solo-google';
import { seal, type PhotoAsset, type SecretSoloSession, type StreetOrientationAsset } from './_solo-session';

type PhotoResult = { displayText: string; photoUrl?: string; rewardEligible: boolean };
type Panorama = { id: string; date?: string; position: Position };
type StreetscapeKind = 'widest-street' | 'two-buildings';

const unavailable = (reason: string): PhotoResult => ({ displayText: `I cannot answer: ${reason}`, rewardEligible: false });

async function photoResult(session: SecretSoloSession, panoramaId: string, plan: SoloPhotoPlan): Promise<PhotoResult> {
  const asset: PhotoAsset = {
    kind: 'solo-photo', version: 1, expiresAt: session.expiresAt,
    panoramaId, heading: ((plan.heading % 360) + 360) % 360, pitch: plan.pitch, fov: plan.fov,
  };
  return { displayText: plan.displayText, photoUrl: `/api/solo/photo?token=${encodeURIComponent(await seal(asset))}`, rewardEligible: true };
}

async function otherZoneStreetscape(session: SecretSoloSession, kind: StreetscapeKind): Promise<Panorama | undefined> {
  const anchor = JSON.stringify([
    session.station.id, session.station.position, session.stationZoneMiles,
    session.spot, session.panorama.id, session.positionRevision ?? 0,
  ]);
  if (session.zonePhotoScenes?.anchor !== anchor) session.zonePhotoScenes = { anchor, scenes: {} };
  const scenes = session.zonePhotoScenes.scenes;
  const currentStreet = nearestStreetOrientation(session.spot)?.name;
  const qualifies = (panorama: Panorama, photoKind: StreetscapeKind) => {
    const other = scenes[photoKind === 'widest-street' ? 'two-buildings' : 'widest-street'];
    if (panorama.id === session.panorama.id || panorama.id === session.stationPanorama?.id || panorama.id === other?.id) return false;
    if (!isHidingPositionAllowed(panorama.position) || distanceMeters(panorama.position, session.station.position) > session.stationZoneMiles * 1609.344) return false;
    if (distanceMeters(panorama.position, session.spot) < ZONE_PHOTO_SEPARATION_METERS) return false;
    if (other && distanceMeters(panorama.position, other.position) < ZONE_PHOTO_SEPARATION_METERS) return false;
    const street = nearestStreetOrientation(panorama.position);
    // Street names/orientations come from the bundled approximate centerline grid.
    return Boolean(street && (photoKind !== 'widest-street' || street.name !== currentStreet));
  };
  const cached = scenes[kind];
  if (cached && qualifies(cached, kind)) return cached;
  const coverage = await panoramasInZone(session.station.position, session.stationZoneMiles);
  const choose = (photoKind: StreetscapeKind) => {
    const candidates = coverage.panoramas.filter((panorama) => qualifies(panorama, photoKind)).sort((a, b) => a.id.localeCompare(b.id));
    if (!candidates.length) return undefined;
    const index = (Math.abs(Math.trunc(session.wideHeading)) + (photoKind === 'two-buildings' ? 7 : 0)) % candidates.length;
    return candidates[index];
  };
  const panorama = choose(kind);
  if (!panorama) return undefined;
  scenes[kind] = panorama;
  // Reuse the same metadata scan for the other card, storing only two small scenes.
  const otherKind = kind === 'widest-street' ? 'two-buildings' : 'widest-street';
  if (!scenes[otherKind]) scenes[otherKind] = choose(otherKind);
  return panorama;
}

/** Each location policy has an exclusive return path: no zone-to-spot fall-through. */
export async function resolveSoloPhoto(session: SecretSoloSession, kind: SoloPhotoKind, direction?: Constraint['direction']): Promise<PhotoResult> {
  const plan = soloPhotoPlan(kind, session.spot, session.station.position, direction, session.wideHeading);
  if (plan.staticAssetUrl) return { displayText: plan.displayText, photoUrl: plan.staticAssetUrl, rewardEligible: false };
  if (plan.generatedAsset === 'street-orientation') {
    const orientation = nearestStreetOrientation(session.spot);
    if (!orientation) return unavailable('the bundled street snapshot has no orientation near this hiding location');
    const asset: StreetOrientationAsset = { kind: 'solo-street-orientation', version: 1, expiresAt: session.expiresAt, bearing: orientation.bearing };
    return { displayText: plan.displayText, photoUrl: `/api/solo/street-orientation?token=${encodeURIComponent(await seal(asset))}`, rewardEligible: true };
  }
  if (plan.source === 'zone') {
    if (kind === 'widest-street' || kind === 'two-buildings') {
      const panorama = await otherZoneStreetscape(session, kind);
      if (!panorama) return unavailable('no separate street scene with usable outdoor Street View was found inside this hiding zone');
      const street = nearestStreetOrientation(panorama.position)!;
      const heading = street.bearing + (kind === 'two-buildings' ? 90 : 0) + (session.wideHeading >= 180 ? 180 : 0);
      return photoResult(session, panorama.id, { ...plan, heading });
    }
    const target = await photoTargetInZone(kind, session.station.position, session.wideHeading, session.stationZoneMiles, {
      panoramaId: session.panorama.id, position: session.spot,
    });
    if (!target?.panorama || target.heading === undefined) return unavailable(target?.unavailableReason ?? 'no qualifying photo scene was found elsewhere in this hiding zone');
    return photoResult(session, target.panorama.id, { ...plan, heading: target.heading, displayText: target.displayText ?? plan.displayText });
  }
  if (plan.source === 'station') {
    if (!session.stationPanorama) {
      const panorama = await panoramaAt(session.station.position);
      if (panorama && distanceMeters(panorama.position, session.station.position) <= session.stationZoneMiles * 1609.344) {
        session.stationPanorama = { id: panorama.id, date: panorama.date };
      }
    }
    return session.stationPanorama ? photoResult(session, session.stationPanorama.id, plan) : unavailable('outdoor Street View is unavailable at the central station');
  }
  if (plan.source === 'spot' && !plan.unavailableReason && session.panorama) return photoResult(session, session.panorama.id, plan);
  return unavailable(plan.unavailableReason ?? 'outdoor Street View is unavailable at the hiding location');
}
