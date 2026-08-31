import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSoloPhoto } from '../api/_solo-photos';
import { photoTargetInZone, ZONE_PHOTO_SEPARATION_METERS } from '../api/_solo-google';
import { seal, unseal, type PhotoAsset, type SecretSoloSession } from '../api/_solo-session';
import questionHandler from '../api/solo/question';
import { distanceMeters, SOLO_PHOTO_LOCATIONS, SOLO_PHOTO_SUBJECTS, soloPhotoLocationNote, soloPhotoPlan } from './solo';
import { nearestStreetOrientation } from './rulebookGeometry';
import { pois } from './data';

function session(): SecretSoloSession {
  const now = new Date().toISOString();
  return {
    kind: 'solo-session', version: 2, sessionId: 'photo-audit', createdAt: now,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), departureTime: now,
    transitScope: 'all', hidingTimeMinutes: 30, stationZoneMiles: 0.25, phase: 'seeking',
    station: { id: 'station', name: 'Station', position: { lat: 37.77, lng: -122.44 } },
    spot: { lat: 37.769, lng: -122.441 }, panorama: { id: 'hiding-pano' }, stationPanorama: { id: 'station-pano' },
    wideHeading: 42, positionRevision: 0, questionNumber: 0, questionUses: {}, cardsDrawn: 0, cardsKept: 0,
    route: { durationSeconds: 600, distanceMeters: 1000, departureTime: now, arrivalTime: now, summary: ['Walk', 'N'] },
    deck: { drawPile: [], hand: [], usedPile: [], discardPile: [], maxHandSize: 6 },
    activeEffects: [], blockedQuestionKeys: [], recentDecisions: [], publicMoves: [],
  };
}

async function asset(result: { photoUrl?: string }) {
  expect(result.photoUrl).toMatch(/^\/api\/solo\/photo\?token=/);
  const token = new URL(result.photoUrl!, 'https://example.test').searchParams.get('token')!;
  return unseal<PhotoAsset>(token, 'solo-photo');
}

function mockStreetCoverage(value: SecretSoloSession) {
  const ids = new Map<string, string>();
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe('/maps/api/streetview/metadata');
    expect(url.searchParams.get('source')).toBe('outdoor');
    const location = url.searchParams.get('location')!;
    const [lat, lng] = location.split(',').map(Number);
    if (!ids.has(location)) ids.set(location, `zone-scene-${ids.size}`);
    const station = value.station.position;
    return Response.json({ status: 'OK', pano_id: lat === station.lat && lng === station.lng ? 'station-pano' : ids.get(location), location: { lat, lng } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Solo photo location audit', () => {
  beforeEach(() => {
    vi.stubEnv('SOLO_SESSION_SECRET', 'photo-test-secret-at-least-24-characters');
    vi.stubEnv('GOOGLE_MAPS_SERVER_API_KEY', 'photo-test-key');
    vi.stubEnv('GEMINI_API_KEY', '');
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('assigns an explicit, consistent location policy to every photo card', () => {
    const value = session();
    expect(Object.keys(SOLO_PHOTO_LOCATIONS).sort()).toEqual(SOLO_PHOTO_SUBJECTS.map(({ id }) => id).sort());
    for (const { id } of SOLO_PHOTO_SUBJECTS) {
      expect(soloPhotoPlan(id, value.spot, value.station.position).source, id).toBe(SOLO_PHOTO_LOCATIONS[id]);
      expect(soloPhotoLocationNote(id)).toMatch(/^Location:/);
    }
    expect(Object.entries(SOLO_PHOTO_LOCATIONS).filter(([, source]) => source === 'spot').map(([id]) => id)).toEqual([
      'the-sky', 'tallest-structure-in-your-sightline', 'trace-nearest-street-path',
    ]);
  });

  it('keeps current-position and station images at their own sources without zone lookups', async () => {
    const value = session();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await asset(await resolveSoloPhoto(value, 'the-sky'))).toMatchObject({ panoramaId: 'hiding-pano', pitch: 90 });
    expect(await asset(await resolveSoloPhoto(value, 'tallest-structure-in-your-sightline'))).toMatchObject({ panoramaId: 'hiding-pano', pitch: 14 });
    for (const kind of ['any-building-visible-from-station', 'tallest-building-visible-from-station'] as const) {
      expect(await asset(await resolveSoloPhoto(value, kind))).toMatchObject({ panoramaId: 'station-pano' });
    }
    expect((await resolveSoloPhoto(value, 'trace-nearest-street-path')).photoUrl).toMatch(/^\/api\/solo\/street-orientation/);
    expect(await resolveSoloPhoto(value, 'you')).toMatchObject({ photoUrl: '/solo-selfie.svg', rewardEligible: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['widest-street', 'two-buildings'], ['two-buildings', 'widest-street'],
  ] as const)('keeps %s and %s at distinct in-zone places in either ask order', async (first, second) => {
    const value = session();
    const spot = structuredClone(value.spot);
    const fetchMock = mockStreetCoverage(value);
    const firstResult = await resolveSoloPhoto(value, first);
    const firstCalls = fetchMock.mock.calls.length;
    const secondResult = await resolveSoloPhoto(value, second);
    expect(fetchMock).toHaveBeenCalledTimes(firstCalls);
    const firstAsset = await asset(firstResult);
    const secondAsset = await asset(secondResult);
    expect(firstAsset.panoramaId).not.toBe(secondAsset.panoramaId);
    const scenes = value.zonePhotoScenes!.scenes;
    for (const scene of [scenes[first]!, scenes[second]!]) {
      expect(scene.id).not.toBe('hiding-pano');
      expect(scene.id).not.toBe('station-pano');
      expect(distanceMeters(scene.position, value.station.position)).toBeLessThanOrEqual(value.stationZoneMiles * 1609.344);
      expect(distanceMeters(scene.position, value.spot)).toBeGreaterThanOrEqual(ZONE_PHOTO_SEPARATION_METERS);
    }
    expect(distanceMeters(scenes[first]!.position, scenes[second]!.position)).toBeGreaterThanOrEqual(ZONE_PHOTO_SEPARATION_METERS);
    expect(nearestStreetOrientation(scenes['widest-street']!.position)?.name).not.toBe(nearestStreetOrientation(value.spot)?.name);
    expect(firstAsset).toMatchObject({ pitch: 0, fov: 120 });
    expect(firstResult.displayText).toContain('hiding zone');
    expect(value.spot).toEqual(spot);
    expect(value.panorama.id).toBe('hiding-pano');
    const calls = fetchMock.mock.calls.length;
    expect((await asset(await resolveSoloPhoto(value, first))).panoramaId).toBe(firstAsset.panoramaId);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });

  it('invalidates saved zone scenes when Xeno moves onto a previously photographed place', async () => {
    const value = session();
    mockStreetCoverage(value);
    await resolveSoloPhoto(value, 'widest-street');
    const old = value.zonePhotoScenes!.scenes['widest-street']!;
    const anchor = value.zonePhotoScenes!.anchor;
    value.spot = old.position;
    value.panorama = { id: old.id };
    value.positionRevision = 1;
    expect((await asset(await resolveSoloPhoto(value, 'widest-street'))).panoramaId).not.toBe(old.id);
    expect(value.zonePhotoScenes!.anchor).not.toBe(anchor);
    expect((await asset(await resolveSoloPhoto(value, 'the-sky'))).panoramaId).toBe(old.id);
  });

  it('uses the configured zone radius and invalidates scenes after a station change', async () => {
    const value = session();
    mockStreetCoverage(value);
    await resolveSoloPhoto(value, 'two-buildings');
    const oldAnchor = value.zonePhotoScenes!.anchor;
    value.station.position = { lat: 37.76, lng: -122.46 };
    value.spot = { lat: 37.7598, lng: -122.4602 };
    value.stationZoneMiles = 0.1;
    await asset(await resolveSoloPhoto(value, 'two-buildings'));
    expect(value.zonePhotoScenes!.anchor).not.toBe(oldAnchor);
    expect(distanceMeters(value.zonePhotoScenes!.scenes['two-buildings']!.position, value.station.position)).toBeLessThanOrEqual(0.1 * 1609.344);
  });

  it.each(['hiding-id', 'near-hider', 'outside-zone'] as const)('rejects %s metadata without substituting the hiding panorama', async (mode) => {
    const value = session();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      status: 'OK', pano_id: mode === 'hiding-id' ? 'hiding-pano' : 'other-id',
      location: mode === 'outside-zone' ? { lat: 37.785, lng: -122.44 } : { lat: value.spot.lat + 0.00001, lng: value.spot.lng },
    })));
    for (const kind of ['widest-street', 'two-buildings'] as const) {
      expect(await resolveSoloPhoto(value, kind)).toEqual({ displayText: expect.stringMatching(/^I cannot answer:/), rewardEligible: false });
    }
  });

  it('does not reuse the widest-street location when it is the only scene available for Two buildings', async () => {
    const value = session();
    mockStreetCoverage(value);
    await resolveSoloPhoto(value, 'widest-street');
    const onlyScene = value.zonePhotoScenes!.scenes['widest-street']!;
    delete value.zonePhotoScenes!.scenes['two-buildings'];
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'OK', pano_id: onlyScene.id, location: onlyScene.position })));
    expect(await resolveSoloPhoto(value, 'two-buildings')).toMatchObject({ rewardEligible: false });
    expect((await resolveSoloPhoto(value, 'two-buildings')).photoUrl).toBeUndefined();
  });

  it('returns the targeted tree scene through the question API without overwriting it with the hiding photo', async () => {
    const value = session();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => String(input).includes('places.googleapis.com')
      ? Response.json({ places: [{ id: 'park', displayName: { text: 'Secret Park' }, location: { latitude: 37.771, longitude: -122.441 }, userRatingCount: 10 }] })
      : Response.json({ status: 'OK', pano_id: 'tree-park-pano', location: { lat: 37.771, lng: -122.441 } })));
    const response = await questionHandler(new Request('https://example.test/api/solo/question', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: await seal(value), constraint: { id: 'tree', name: 'A tree', kind: 'photo-reference', enabled: true, answer: 'yes', origin: value.spot, category: 'a-tree' } }),
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(await asset(body)).toMatchObject({ panoramaId: 'tree-park-pano', fov: 75 });
    expect(body.displayText).toMatch(/park elsewhere in the hiding zone/);
    expect(body.displayText).not.toMatch(/Secret Park|37\.771|-122\.441/);
    expect(body).not.toHaveProperty('zonePhotoScenes');
  });

  it.each(['a-tree', 'restaurant-interior', 'park', 'grocery-store-aisle', 'place-of-worship'] as const)('does not use the current panorama for the zone-targeted %s card', async (kind) => {
    const value = session();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => String(input).includes('places.googleapis.com')
      ? Response.json({ places: [{ id: 'place', displayName: { text: 'Place' }, location: { latitude: value.spot.lat, longitude: value.spot.lng }, userRatingCount: 10 }] })
      : Response.json({ status: 'OK', pano_id: 'hiding-pano', location: value.spot })));
    const result = await resolveSoloPhoto(value, kind);
    expect(result.rewardEligible).toBe(false);
    expect(result.photoUrl).toBeUndefined();
  });

  it('continues to another venue when Street View snaps outside the zone', async () => {
    const value = session();
    let panoramaCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('places.googleapis.com')) return Response.json({ places: [
        { id: 'near', location: { latitude: 37.7701, longitude: -122.44 }, userRatingCount: 10 },
        { id: 'other', location: { latitude: 37.771, longitude: -122.44 }, userRatingCount: 10 },
      ] });
      panoramaCalls += 1;
      return Response.json({ status: 'OK', pano_id: `venue-${panoramaCalls}`, location: { lat: panoramaCalls === 1 ? 37.78 : 37.771, lng: -122.44 } });
    }));
    const target = await photoTargetInZone('park', value.station.position, 42, value.stationZoneMiles, { panoramaId: value.panorama.id, position: value.spot });
    expect(target?.panorama?.id).toBe('venue-2');
    expect(panoramaCalls).toBe(2);
  });

  it('treats the platform as a zone target, rejecting the hiding panorama even at a mapped rail station', async () => {
    const value = session();
    const rail = pois.find((poi) => poi.category === 'rail-station')!;
    value.station.position = { lat: rail.lat, lng: rail.lng };
    value.spot = { lat: rail.lat + 0.001, lng: rail.lng };
    let panoId = 'platform-zone';
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'OK', pano_id: panoId, location: value.station.position })));
    expect(await asset(await resolveSoloPhoto(value, 'train-platform'))).toMatchObject({ panoramaId: 'platform-zone' });
    panoId = 'hiding-pano';
    const rejected = await resolveSoloPhoto(value, 'train-platform');
    expect(rejected.rewardEligible).toBe(false);
    expect(rejected.photoUrl).toBeUndefined();
  });

  it.each(['widest-street', 'two-buildings', 'a-tree'] as const)('gives no question reward when %s has no alternate scene', async (kind) => {
    const value = session();
    value.deck.drawPile = ['time-2#1'];
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'ZERO_RESULTS', places: [] })));
    const response = await questionHandler(new Request('https://example.test/api/solo/question', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: await seal(value), constraint: { id: kind, name: kind, kind: 'photo-reference', enabled: true, answer: 'yes', origin: value.spot, category: kind } }),
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ cardsDrawn: 0, cardsKept: 0, displayText: expect.stringMatching(/^I cannot answer:/) });
    expect(body.photoUrl).toBeUndefined();
    expect((await unseal<SecretSoloSession>(body.token, 'solo-session')).deck.drawPile).toEqual(['time-2#1']);
  });
});
