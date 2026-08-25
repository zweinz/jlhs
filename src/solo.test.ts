import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { choosePanorama, chunk, reachableStations, verifyTransitRoute } from '../api/_solo-google';
import { commitmentFor, seal, unseal, type PhotoAsset, type SecretSoloSession } from '../api/_solo-session';
import questionHandler from '../api/solo/question';
import checkLocationHandler from '../api/solo/check-location';
import {
  cardsForQuestion,
  canonicalQuestionKey,
  keptCardsForQuestion,
  keptCardsFromQuestionUses,
  migrateSoloPhotoKind,
  publicSoloDisplayText,
  questionUseCounts,
  sfLocalDateTimeToIso,
  soloPhotoPlan,
  soloRevealMapFeatures,
  SOLO_PHOTO_SUBJECTS,
  stationDifficulty,
  verifyRevealCommitment,
  type SoloReveal,
} from './solo';
import { validStations } from './transit';

describe('Solo question accounting', () => {
  it('multiplies draw costs for repeated cards', () => {
    const radar = { kind: 'radar' as const, distanceMiles: 1 };
    const measuring = { kind: 'measuring' as const, category: 'museum' };
    const photo = { kind: 'photo-reference' as const, category: 'a-tree' };
    expect([0, 1, 2].map((uses) => cardsForQuestion(radar, uses))).toEqual([2, 4, 6]);
    expect([0, 1].map((uses) => cardsForQuestion(measuring, uses))).toEqual([3, 6]);
    expect([0, 1].map((uses) => cardsForQuestion(photo, uses))).toEqual([1, 2]);
    expect([0, 1, 2].map((uses) => keptCardsForQuestion(radar, uses))).toEqual([1, 2, 3]);
    expect([0, 1].map((uses) => keptCardsForQuestion(measuring, uses))).toEqual([1, 2]);
    expect([0, 1].map((uses) => keptCardsForQuestion(photo, uses))).toEqual([1, 2]);
    expect([0, 1].map((uses) => keptCardsForQuestion({ kind: 'tentacle' }, uses))).toEqual([2, 4]);
    expect(keptCardsFromQuestionUses({ 'radar:1.000': 3, 'tentacle:museum': 2 })).toBe(12);
  });

  it('uses distance for radar identity and subject for category cards', () => {
    expect(canonicalQuestionKey({ kind: 'radar', distanceMiles: 0.25 })).toBe('radar:0.250');
    expect(canonicalQuestionKey({ kind: 'measuring', category: 'museum' })).toBe('measuring:museum');
  });

  it('counts prior uses by the repeat-rule card identity', () => {
    expect(questionUseCounts([
      { kind: 'radar', distanceMiles: 0.25 },
      { kind: 'radar', distanceMiles: 0.25 },
      { kind: 'radar', distanceMiles: 1 },
      { kind: 'matching-region', category: 'museum' },
    ])).toEqual({
      'radar:0.250': 2,
      'radar:1.000': 1,
      'matching-region:museum': 1,
    });
  });

  it('sanitizes legacy response details while preserving named Tentacle answers', () => {
    expect(publicSoloDisplayText('matching-region', 'No — seeker: Presidio Golf Course; hider: Gleneagles')).toBe('No');
    expect(publicSoloDisplayText('matching-region', 'Yes — Gleneagles')).toBe('Yes');
    expect(publicSoloDisplayText('measuring', 'Farther (higher elevation)')).toBe('Further');
    expect(publicSoloDisplayText('tentacle', 'Gleneagles')).toBe('Gleneagles');
  });
});

describe('Solo camera and time rules', () => {
  const spot = { lat: 37.77, lng: -122.44 };
  const station = { lat: 37.78, lng: -122.44 };

  it('maps the supported Solo inventory to actual rulebook photo cards', () => {
    expect(SOLO_PHOTO_SUBJECTS.map((subject) => subject.id)).toEqual([
      'a-tree',
      'the-sky',
      'you',
      'widest-street',
      'tallest-structure-in-your-sightline',
      'any-building-visible-from-station',
      'tallest-building-visible-from-station',
      'trace-nearest-street-path',
      'two-buildings',
      'restaurant-interior',
      'park',
      'grocery-store-aisle',
      'place-of-worship',
      'train-platform',
      'half-mile-of-streets-traced',
      'tallest-mountain-visible-from-station',
      'biggest-body-of-water-in-your-zone',
      'five-buildings',
    ]);
  });

  it('uses the station panorama only for station cards and distinct fixed cameras', () => {
    const anyBuilding = soloPhotoPlan('any-building-visible-from-station', spot, station, 'north', 42);
    const tallestBuilding = soloPhotoPlan('tallest-building-visible-from-station', spot, station, 'north', 42);
    const tree = soloPhotoPlan('a-tree', spot, station, 'north', 42);
    expect(anyBuilding.source).toBe('station');
    expect(anyBuilding.displayText).toMatch(/at the central station/);
    expect(tallestBuilding.source).toBe('station');
    expect(tallestBuilding.heading).not.toBe(anyBuilding.heading);
    expect(tree.source).toBe('spot');
    expect(tree.displayText).toMatch(/at the hiding location/);
    expect(soloPhotoPlan('the-sky', spot, station, 'north', 42).pitch).toBe(90);
    expect(soloPhotoPlan('restaurant-interior', spot, station, 'north', 42).unavailableReason).toMatch(/outdoor/i);
  });

  it('keeps legacy toward and away views visually distinct while migrating old drafts', () => {
    const toward = soloPhotoPlan('toward-station', spot, station, 'north', 42);
    const away = soloPhotoPlan('away-from-station', spot, station, 'north', 42);
    expect(Math.abs(toward.heading - away.heading)).toBe(180);
    expect(toward.fov).not.toBe(away.fov);
    expect(migrateSoloPhotoKind('toward-station')).toBe('any-building-visible-from-station');
    expect(migrateSoloPhotoKind('sky-above')).toBe('the-sky');
  });

  it('converts San Francisco wall time across standard and daylight time', () => {
    expect(sfLocalDateTimeToIso('2026-01-15T12:00')).toBe('2026-01-15T20:00:00.000Z');
    expect(sfLocalDateTimeToIso('2026-08-24T12:00')).toBe('2026-08-24T19:00:00.000Z');
    expect(() => sfLocalDateTimeToIso('2026-03-08T02:30')).toThrow(/daylight saving/i);
  });

  it('favors longer trips and sparse station areas', () => {
    expect(stationDifficulty(1800, 0)).toBeCloseTo(1);
    expect(stationDifficulty(300, 10)).toBeLessThan(stationDifficulty(1700, 2));
  });

  it('never chooses the hiding panorama at the station', () => {
    const near = { id: 'near', position: { lat: station.lat - 0.0001, lng: station.lng } };
    const away = { id: 'away', position: { lat: station.lat - 0.0025, lng: station.lng } };
    expect(choosePanorama([near, away], station)?.id).toBe('away');
    expect(choosePanorama([near], station)).toBeUndefined();
  });

  it('creates distinct map markers for the central station and hiding spot', () => {
    const [stationFeature, spotFeature] = soloRevealMapFeatures({
      station: { id: 'station', name: 'Central', position: station },
      spot,
    });
    expect(stationFeature.geometry.coordinates).toEqual([station.lng, station.lat]);
    expect(stationFeature.properties).toMatchObject({ kind: 'solo-reveal-station', areaName: 'Central station: Central' });
    expect(spotFeature.geometry.coordinates).toEqual([spot.lng, spot.lat]);
    expect(spotFeature.properties).toMatchObject({ kind: 'solo-reveal', areaName: 'AI hiding spot' });
  });
});

describe('Google transit request boundaries', () => {
  beforeEach(() => { (globalThis as unknown as { process: { env: Record<string, string> } }).process.env.GOOGLE_MAPS_SERVER_API_KEY = 'test-key'; });
  afterEach(() => vi.unstubAllGlobals());

  it('splits the 193 station pool into 100 and 93 destinations and enforces 30 minutes', async () => {
    const destinationCounts: number[] = [];
    const requestUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requestUrls.push(url);
      const body = JSON.parse(String(init?.body));
      destinationCounts.push(body.destinations.length);
      return Response.json(body.destinations.map((_: unknown, index: number) => ({
        destinationIndex: index,
        condition: 'ROUTE_EXISTS',
        duration: index === 0 ? '1800s' : '1801s',
        distanceMeters: 1000,
      })));
    }));
    const reachable = await reachableStations({ lat: 37.77, lng: -122.44 }, '2026-08-24T19:00:00.000Z');
    expect(destinationCounts).toEqual([100, 93]);
    expect(requestUrls).toEqual([
      'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix',
      'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix',
    ]);
    expect(reachable).toHaveLength(2);
    expect(chunk(Array.from({ length: 193 }), 100).map((part) => part.length)).toEqual([100, 93]);
  });

  it('rejects walking-only detailed routes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ routes: [{
      duration: '900s', distanceMeters: 900,
      legs: [{ steps: [{ travelMode: 'WALK' }] }],
    }] })));
    await expect(verifyTransitRoute(
      { lat: 37.77, lng: -122.44 }, { lat: 37.78, lng: -122.43 }, '2026-08-24T19:00:00.000Z',
    )).resolves.toBeNull();
  });

  it('reports quota exhaustion instead of claiming no stations are reachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([{
      destinationIndex: 0,
      status: { code: 8, message: 'Quota exceeded.' },
      condition: 'ROUTE_NOT_FOUND',
    }])));
    await expect(reachableStations(
      { lat: 37.77, lng: -122.44 }, '2026-08-24T19:00:00.000Z',
    )).rejects.toThrow(/quota is temporarily exhausted/i);
  });

  it('keeps usable stations when another matrix batch is rate limited', async () => {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1;
      if (call === 1) return Response.json([{
        destinationIndex: 0,
        status: {},
        condition: 'ROUTE_EXISTS',
        duration: '900s',
        distanceMeters: 1000,
      }]);
      return Response.json({ error: { message: 'Resource has been exhausted.' } }, { status: 429 });
    }));
    const reachable = await reachableStations(
      { lat: 37.77, lng: -122.44 }, '2026-08-24T19:00:00.000Z',
    );
    expect(reachable).toHaveLength(1);
    expect(call).toBe(2);
  });

  it('recognizes a terminal resource-exhausted record in a streamed matrix', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([{
      destinationIndex: 0,
      status: { code: 13, message: 'Internal Error Encountered.' },
    }, {
      error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted.' },
    }])));
    await expect(reachableStations(
      { lat: 37.77, lng: -122.44 }, '2026-08-24T19:00:00.000Z',
    )).rejects.toThrow(/quota is temporarily exhausted/i);
  });

  it('includes Google error details for malformed matrix requests', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      error: { message: 'Request field is invalid.' },
    }, { status: 400 })));
    await expect(reachableStations(
      { lat: 37.77, lng: -122.44 }, '2026-08-24T19:00:00.000Z',
    )).rejects.toThrow(/400.*Request field is invalid/i);
  });
});

describe('Solo token and commitment security', () => {
  beforeEach(() => { (globalThis as unknown as { process: { env: Record<string, string> } }).process.env.SOLO_SESSION_SECRET = 'test-secret-with-at-least-24-characters'; });

  const session = (): SecretSoloSession => ({
    kind: 'solo-session', version: 1, sessionId: 'session', createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(), departureTime: '2026-08-24T19:00:00.000Z',
    salt: 'salt', commitment: '', commitmentVersion: 2, phase: 'seeking', cardsDrawn: 0, questionUses: {}, wideHeading: 42,
    station: { id: 'station', name: 'Station', position: { lat: 37.78, lng: -122.44 } },
    spot: { lat: 37.779, lng: -122.441 }, panorama: { id: 'pano', date: '2026-01' },
    stationPanorama: { id: 'station-pano', date: '2026-01' },
    route: { durationSeconds: 1200, distanceMeters: 4000, departureTime: '2026-08-24T19:00:00.000Z', arrivalTime: '2026-08-24T19:20:00.000Z', summary: ['Walk', 'N', 'Walk'] },
  });

  it('round trips encrypted sessions and rejects tampering', async () => {
    const value = session();
    const token = await seal(value);
    await expect(unseal<SecretSoloSession>(token, 'solo-session')).resolves.toEqual(value);
    const [iv, ciphertext] = token.split('.');
    const tamperIndex = Math.floor(ciphertext.length / 2);
    const tamperedCiphertext = `${ciphertext.slice(0, tamperIndex)}${ciphertext[tamperIndex] === 'x' ? 'y' : 'x'}${ciphertext.slice(tamperIndex + 1)}`;
    const tamperedToken = `${iv}.${tamperedCiphertext}`;
    await expect(unseal<SecretSoloSession>(tamperedToken, 'solo-session')).rejects.toThrow(/invalid|expired/i);
  });

  it('verifies the public reveal against the original commitment', async () => {
    const value = session();
    value.commitment = await commitmentFor(value);
    const reveal: SoloReveal = {
      reason: 'found', station: value.station, spot: value.spot,
      panorama: { ...value.panorama, imageUrl: '/api/solo/photo?token=opaque' }, route: value.route,
      stationPanorama: value.stationPanorama, commitmentVersion: value.commitmentVersion,
      sessionId: value.sessionId, salt: value.salt, commitment: value.commitment,
    };
    await expect(verifyRevealCommitment(reveal)).resolves.toBe(true);
    await expect(verifyRevealCommitment({ ...reveal, spot: { ...reveal.spot, lat: 37.7 } })).resolves.toBe(false);
  });

  it('keeps the hidden position encrypted while rotating question state and repetition costs', async () => {
    const value = session();
    value.commitment = await commitmentFor(value);
    const constraint = {
      id: 'q', name: 'Radar', kind: 'radar' as const, enabled: true, answer: 'yes' as const,
      origin: value.spot, distanceMiles: 1,
    };
    const first = await questionHandler(new Request('https://example.test/api/solo/question', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: await seal(value), constraint }),
    }));
    const firstBody = await first.json();
    expect(first.status).toBe(200);
    expect(firstBody.cardsDrawn).toBe(2);
    expect(firstBody.cardsKept).toBe(1);
    expect(firstBody.totalCardsDrawn).toBe(2);
    expect(firstBody.totalCardsKept).toBe(1);
    expect(JSON.stringify(firstBody)).not.toContain('37.779');

    const second = await questionHandler(new Request('https://example.test/api/solo/question', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: firstBody.token, constraint }),
    }));
    const secondBody = await second.json();
    expect(secondBody.cardsDrawn).toBe(4);
    expect(secondBody.cardsKept).toBe(2);
    expect(secondBody.totalCardsDrawn).toBe(6);
    expect(secondBody.totalCardsKept).toBe(3);
  });

  it('issues station and hiding-spot photos from separate panoramas with distinct cameras', async () => {
    const value = session();
    value.commitment = await commitmentFor(value);
    const askPhoto = async (category: string) => {
      const response = await questionHandler(new Request('https://example.test/api/solo/question', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: await seal(value),
          constraint: {
            id: category, name: category, kind: 'photo-reference', enabled: true, answer: 'yes',
            origin: value.spot, category,
          },
        }),
      }));
      const body = await response.json();
      expect(response.status).toBe(200);
      const assetToken = new URL(body.photoUrl, 'https://example.test').searchParams.get('token');
      expect(assetToken).toBeTruthy();
      return { body, asset: await unseal<PhotoAsset>(assetToken!, 'solo-photo') };
    };

    const stationPhoto = await askPhoto('any-building-visible-from-station');
    const otherStationPhoto = await askPhoto('tallest-building-visible-from-station');
    const spotPhoto = await askPhoto('a-tree');
    expect(stationPhoto.asset.panoramaId).toBe('station-pano');
    expect(stationPhoto.body.displayText).toMatch(/at the central station/);
    expect(otherStationPhoto.asset.heading).not.toBe(stationPhoto.asset.heading);
    expect(spotPhoto.asset.panoramaId).toBe('pano');
    expect(spotPhoto.body.displayText).toMatch(/at the hiding location/);
  });

  it('returns a valid cannot-answer result for photo subjects Street View cannot supply', async () => {
    const value = session();
    value.commitment = await commitmentFor(value);
    const response = await questionHandler(new Request('https://example.test/api/solo/question', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: await seal(value),
        constraint: {
          id: 'photo-interior', name: 'Restaurant interior', kind: 'photo-reference', enabled: true,
          answer: 'yes', origin: value.spot, category: 'restaurant-interior',
        },
      }),
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.displayText).toMatch(/^I cannot answer:/);
    expect(body.photoUrl).toBeUndefined();
    expect(body.cardsDrawn).toBe(1);
    expect(body.cardsKept).toBe(1);
  });

  it('starts end game for an in-zone pin and charges exactly one card for a miss', async () => {
    const value = session();
    value.commitment = await commitmentFor(value);
    const ask = async (token: string, origin: { lat: number; lng: number }) => {
      const response = await questionHandler(new Request('https://example.test/api/solo/question', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token,
          constraint: { id: crypto.randomUUID(), name: 'Confirm end game', kind: 'endgame-confirmation', enabled: true, answer: 'no', origin },
        }),
      }));
      expect(response.status).toBe(200);
      return response.json();
    };
    const miss = await ask(await seal(value), { lat: 37.72, lng: -122.50 });
    expect(miss.answer).toBe('no');
    expect(miss.phase).toBe('seeking');
    expect(miss.cardsDrawn).toBe(1);
    expect(miss.cardsKept).toBe(0);
    expect(miss.totalCardsDrawn).toBe(1);

    const correct = await ask(miss.token, value.station.position);
    expect(correct.answer).toBe('yes');
    expect(correct.phase).toBe('end-game');
    expect(correct.cardsDrawn).toBe(0);
    expect(correct.totalCardsDrawn).toBe(1);
  });

  it('counts a rulebook null answer without adding a geographic constraint', async () => {
    const value = session();
    value.commitment = await commitmentFor(value);
    const constraint = {
      id: 'q-null', name: 'Matching commercial airport', kind: 'matching-region' as const,
      enabled: true, answer: 'yes' as const, origin: value.spot, category: 'commercial-airport',
    };
    const response = await questionHandler(new Request('https://example.test/api/solo/question', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: await seal(value), constraint }),
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.answer).toBe('null');
    expect(body.displayText).toBe('Null');
    expect(body.cardsDrawn).toBe(3);
    expect(body.cardsKept).toBe(1);
    expect(body.totalCardsDrawn).toBe(3);
    expect(body.totalCardsKept).toBe(1);
    expect(body.resolvedRegionId).toBeUndefined();
  });

  it('answers transit matching from the committed station, not the nearest station to the hiding spot', async () => {
    const rapidStop = validStations.find((station) => station.name === 'Geary Blvd & 6th Ave')!;
    const localOnlyStop = validStations.find((station) => station.name === 'V.A. Hospital')!;
    const value = session();
    value.station = { id: rapidStop.id, name: rapidStop.name, position: rapidStop };
    value.spot = localOnlyStop;
    value.commitment = await commitmentFor(value);
    const constraint = {
      id: 'q-transit-match', name: 'Matching transit service', kind: 'matching-region' as const,
      enabled: true, answer: 'no' as const, origin: value.spot, category: 'transit-route', regionId: '38R',
    };
    const response = await questionHandler(new Request('https://example.test/api/solo/question', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: await seal(value), constraint }),
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.answer).toBe('yes');
    expect(body.displayText).toBe('Yes');
  });

  it('announces end game at the zone and reveals only inside the 30-meter finish radius', async () => {
    const value = session();
    value.commitment = await commitmentFor(value);
    const zoneCheck = await checkLocationHandler(new Request('https://example.test/api/solo/check-location', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: await seal(value), position: value.station.position }),
    }));
    const zoneBody = await zoneCheck.json();
    expect(zoneBody.phase).toBe('end-game');
    expect(zoneBody.reveal).toBeUndefined();

    const foundCheck = await checkLocationHandler(new Request('https://example.test/api/solo/check-location', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: zoneBody.token, position: value.spot }),
    }));
    const foundBody = await foundCheck.json();
    expect(foundBody.phase).toBe('found');
    expect(foundBody.reveal.spot).toEqual(value.spot);
  });
});
