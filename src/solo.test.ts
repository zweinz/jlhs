import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { choosePanorama, chunk, photoTargetInZone, reachableStations, TARGETED_PHOTO_KINDS, verifyTransitRoute } from '../api/_solo-google';
import { MAX_SOLO_TOKEN_LENGTH, seal, unseal, type PhotoAsset, type SecretSoloSession, type StreetOrientationAsset } from '../api/_solo-session';
import questionHandler, { randomizeCandidates } from '../api/solo/question';
import streetOrientationHandler, { streetOrientationSvg } from '../api/solo/street-orientation';
import cardEventHandler from '../api/solo/card-event';
import clockHandler from '../api/solo/clock';
import checkLocationHandler from '../api/solo/check-location';
import revealHandler from '../api/solo/reveal';
import {
  cardsForQuestion,
  answeredSoloConstraint,
  askedChoiceLabel,
  canonicalQuestionKey,
  keptCardsForQuestion,
  keptCardsFromQuestionUses,
  publicSoloDisplayText,
  questionUseCounts,
  sfLocalDateTimeToIso,
  soloStateForNewGame,
  soloPhotoPlan,
  soloPhotoOptionLabel,
  soloRevealMapFeatures,
  SOLO_PHOTO_SUBJECTS,
  stationDifficulty,
  vetoedSoloConstraint,
  formatElapsedTime,
} from './solo';
import { primaryTransitStationIds, validStations } from './transit';
import { isHidingPositionAllowed } from './noHideZones';
import { createDeck } from './cards';
import type { SharedState } from './types';
import { deterministicMazeSvg, playPostAnswerCard, publicCardState } from '../api/_solo-cards';
import { pois } from './data';
import { solveHiderQuestion } from './hider';

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
    expect(keptCardsFromQuestionUses({ 'radar:1.000': 3, 'tentacle:museum': 2, 'photo-reference:you': 8 })).toBe(12);
  });

  it('uses distance for radar identity and subject for category cards', () => {
    expect(canonicalQuestionKey({ kind: 'radar', distanceMiles: 0.25 })).toBe('radar:0.250');
    expect(canonicalQuestionKey({ kind: 'radar', distanceMiles: 2.75 })).toBe('radar:custom');
    expect(canonicalQuestionKey({ kind: 'radar', distanceMiles: 7 })).toBe('radar:custom');
    expect(canonicalQuestionKey({ kind: 'thermometer', distanceMiles: 2 })).toBe('thermometer:custom');
    expect(canonicalQuestionKey({ kind: 'measuring', category: 'museum' })).toBe('measuring:museum');
  });

  it('counts prior uses by the repeat-rule card identity', () => {
    expect(questionUseCounts([
      { kind: 'radar', distanceMiles: 0.25 },
      { kind: 'radar', distanceMiles: 0.25 },
      { kind: 'radar', distanceMiles: 1 },
      { kind: 'radar', distanceMiles: 2.75 },
      { kind: 'radar', distanceMiles: 7 },
      { kind: 'matching-region', category: 'museum' },
    ])).toEqual({
      'radar:0.250': 2,
      'radar:1.000': 1,
      'radar:custom': 2,
      'matching-region:museum': 1,
    });
  });

  it('labels only choices that have already been asked', () => {
    expect(askedChoiceLabel('3 miles', 0)).toBe('3 miles');
    expect(askedChoiceLabel('3 miles', 1)).toBe('3 miles · asked 1x');
    expect(askedChoiceLabel('Museum', 2)).toBe('Museum · asked 2x');
  });

  it('makes a randomized replacement the visible and map-driving answered constraint', () => {
    const original = { id: 'q', name: 'Radar · 0.25 mi', kind: 'radar' as const, enabled: true, answer: 'yes' as const, origin: { lat: 37.77, lng: -122.44 }, distanceMiles: 0.25 };
    const replacement = { ...original, name: 'Radar · 1 mi', distanceMiles: 1 };
    expect(answeredSoloConstraint(original, replacement, 'no')).toEqual(expect.objectContaining({
      id: 'q', name: 'Radar · 1 mi', distanceMiles: 1, answer: 'no', answerSet: true, enabled: true,
    }));
  });

  it('removes a vetoed unanswered constraint from map calculations', () => {
    const original = { id: 'q', name: 'Radar', kind: 'radar' as const, enabled: true, answer: 'yes' as const, origin: { lat: 37.77, lng: -122.44 }, distanceMiles: 1 };
    expect(vetoedSoloConstraint(original)).toEqual({ ...original, enabled: false });
  });

  it('sanitizes private response details while preserving named Tentacle answers', () => {
    expect(publicSoloDisplayText('matching-region', 'No — seeker: Presidio Golf Course; hider: Gleneagles')).toBe('No');
    expect(publicSoloDisplayText('matching-region', 'Yes — Gleneagles')).toBe('Yes');
    expect(publicSoloDisplayText('measuring', 'Farther (higher elevation)')).toBe('Further');
    expect(publicSoloDisplayText('tentacle', 'Gleneagles')).toBe('Gleneagles');
  });
});

describe('Solo camera and time rules', () => {
  const spot = { lat: 37.77, lng: -122.44 };
  const station = { lat: 37.78, lng: -122.44 };

  it('freezes the selected transit scope into the Solo board', () => {
    const base: SharedState = {
      version: 2, constraints: [], layers: {}, viewport: { center: spot, zoom: 13 }, mode: 'hider',
      stationZoneMiles: 1, areaDisplayMode: 'allowed-green', transitScope: 'primary',
      stationStatuses: {}, routeStatuses: {},
      manualReachBoundary: { enabled: true, visible: true, regions: [{ id: 'old', points: [spot, station, { lat: 37.77, lng: -122.43 }] }] },
    };
    expect(soloStateForNewGame(base).transitScope).toBe('primary');
    expect(soloStateForNewGame(base).stationZoneMiles).toBe(1);
    expect(soloStateForNewGame(base).manualReachBoundary).toMatchObject({ enabled: false, visible: true });
  });

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
    ]);
  });

  it('marks every Solo photo option as having an implementation path', () => {
    const labels = Object.fromEntries(SOLO_PHOTO_SUBJECTS.map((subject) => [subject.id, soloPhotoOptionLabel(subject)]));
    expect(labels['trace-nearest-street-path']).toBe('Trace nearest street/path');
    expect(Object.entries(labels).filter(([, label]) => label.endsWith('(unavailable)'))).toEqual([]);
  });

  it('uses the station panorama only for station cards and distinct fixed cameras', () => {
    const anyBuilding = soloPhotoPlan('any-building-visible-from-station', spot, station, 'north', 42);
    const tallestBuilding = soloPhotoPlan('tallest-building-visible-from-station', spot, station, 'north', 42);
    const tree = soloPhotoPlan('a-tree', spot, station, 'north', 42);
    expect(anyBuilding.source).toBe('station');
    expect(anyBuilding.displayText).toMatch(/at the central station/);
    expect(tallestBuilding.source).toBe('station');
    expect(tallestBuilding.heading).not.toBe(anyBuilding.heading);
    expect(tree.source).toBe('zone');
    expect(tree.displayText).toMatch(/elsewhere in the hiding zone/);
    expect(soloPhotoPlan('the-sky', spot, station, 'north', 42).pitch).toBe(90);
    const selfie = soloPhotoPlan('you', spot, station, 'north', 42);
    expect(selfie).toMatchObject({ source: 'static', staticAssetUrl: '/solo-selfie.svg' });
    expect(selfie.unavailableReason).toBeUndefined();
    expect(soloPhotoPlan('trace-nearest-street-path', spot, station, 'north', 42)).toMatchObject({
      source: 'spot', generatedAsset: 'street-orientation',
    });
    expect(soloPhotoPlan('restaurant-interior', spot, station, 'north', 42).source).toBe('zone');
  });

  it('has a deliberate best-effort implementation path for every Solo photo subject', () => {
    const directlyRendered = SOLO_PHOTO_SUBJECTS
      .map((subject) => subject.id)
      .filter((kind) => soloPhotoPlan(kind, spot, station, 'north', 42).source !== 'zone');
    const covered = new Set([...directlyRendered, ...TARGETED_PHOTO_KINDS, 'widest-street', 'two-buildings']);
    expect(SOLO_PHOTO_SUBJECTS.map((subject) => subject.id).filter((kind) => !covered.has(kind))).toEqual([]);
    expect(SOLO_PHOTO_SUBJECTS.find((subject) => subject.id === 'trace-nearest-street-path')?.help).toMatch(/precomputed orientation/i);
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
    expect(spotFeature.properties).toMatchObject({ kind: 'solo-reveal', areaName: 'Xeno hiding spot' });
  });
});

describe('Google transit request boundaries', () => {
  beforeEach(() => { (globalThis as unknown as { process: { env: Record<string, string> } }).process.env.GOOGLE_MAPS_SERVER_API_KEY = 'test-key'; });
  afterEach(() => vi.unstubAllGlobals());

  it('batches the safety-filtered station pool and enforces 30 minutes', async () => {
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
    const expectedBatches = chunk(validStations.filter(isHidingPositionAllowed), 100).map((part) => part.length);
    expect(destinationCounts).toEqual(expectedBatches);
    expect(requestUrls).toEqual(expectedBatches.map(() => 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix'));
    expect(reachable).toHaveLength(expectedBatches.length);
  });

  it('uses the configured hiding time as the transit cutoff', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return Response.json(body.destinations.map((_: unknown, index: number) => ({
        destinationIndex: index,
        condition: 'ROUTE_EXISTS',
        duration: index === 0 ? '3600s' : '3601s',
        distanceMeters: 1000,
      })));
    }));
    await expect(reachableStations(
      { lat: 37.77, lng: -122.44 }, '2026-08-24T19:00:00.000Z', 'all', 3600,
    )).resolves.toHaveLength(2);
  });

  it.each([
    ['restaurant-interior', 'restaurant', /Restaurant interior.*best-effort/i, true],
    ['park', 'park', /Park.*qualifying park in the hiding zone/i, true],
    ['grocery-store-aisle', 'grocery_store', /Grocery-store aisle.*best-effort/i, false],
    ['place-of-worship', 'church', /Place of worship.*best-effort/i, false],
  ])('targets %s with Places and appropriate Street View coverage', async (kind, expectedType, expectedText, outdoorOnly) => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes('places.googleapis.com')) {
        return Response.json({ places: [{
          id: 'target-place', displayName: { text: 'Cafe Test' },
          location: { latitude: 37.7705, longitude: -122.4405 },
          userRatingCount: 10,
        }] });
      }
      return Response.json({
        status: 'OK', pano_id: 'target-pano', date: '2026-01',
        location: { lat: 37.7704, lng: -122.4404 },
      });
    }));
    const target = await photoTargetInZone(kind, { lat: 37.77, lng: -122.44 }, 42);
    expect(target).toEqual(expect.objectContaining({ panorama: expect.objectContaining({ id: 'target-pano' }) }));
    expect(target?.displayText).toMatch(expectedText);
    expect(target?.displayText).not.toContain('Cafe Test');
    const placesBody = JSON.parse(String(requests[0].init?.body));
    expect(placesBody.includedTypes).toContain(expectedType);
    expect(placesBody.locationRestriction.circle.radius).toBeCloseTo(0.25 * 1609.344);
    expect(new URL(requests[1].url).searchParams.has('source')).toBe(outdoorOnly);
  });

  it('uses a changed hiding-zone radius for target searches', async () => {
    let placesRadius = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('places.googleapis.com')) {
        const body = JSON.parse(String(init?.body));
        placesRadius = body.locationRestriction.circle.radius;
        return Response.json({ places: [] });
      }
      return Response.json({ status: 'ZERO_RESULTS' });
    }));
    await photoTargetInZone('park', { lat: 37.77, lng: -122.44 }, 42, 0.6);
    expect(placesRadius).toBeCloseTo(0.6 * 1609.344);
  });

  it('targets mapped rail stations for the train-platform best effort', async () => {
    const rail = pois.find((poi) => poi.category === 'rail-station')!;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(new URL(url).searchParams.has('source')).toBe(false);
      return Response.json({
        status: 'OK', pano_id: 'platform-pano', date: '2026-01',
        location: { lat: rail.lat, lng: rail.lng },
      });
    }));
    const target = await photoTargetInZone('train-platform', rail, 42);
    expect(target).toEqual(expect.objectContaining({
      panorama: expect.objectContaining({ id: 'platform-pano' }),
      heading: 42,
      displayText: expect.stringMatching(/Train platform/i),
    }));
  });

  it('limits the matrix destination pool to light-rail and Rapid stations when requested', async () => {
    const destinationCounts: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      destinationCounts.push(body.destinations.length);
      return Response.json([]);
    }));
    await reachableStations(
      { lat: 37.77, lng: -122.44 }, '2026-08-24T19:00:00.000Z', 'primary',
    );
    expect(destinationCounts).toEqual([validStations.filter((station) =>
      primaryTransitStationIds.includes(station.id) && isHidingPositionAllowed(station)).length]);
    expect(primaryTransitStationIds.length).toBeLessThan(validStations.length);
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

describe('Solo token and card-session security', () => {
  beforeEach(() => { (globalThis as unknown as { process: { env: Record<string, string> } }).process.env.SOLO_SESSION_SECRET = 'test-secret-with-at-least-24-characters'; });
  afterEach(() => vi.useRealTimers());

  const session = (): SecretSoloSession => ({
    kind: 'solo-session', version: 2, sessionId: 'session', createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), departureTime: '2026-08-24T19:00:00.000Z', transitScope: 'all',
    hidingTimeMinutes: 30, stationZoneMiles: 0.25,
    phase: 'seeking', cardsDrawn: 0, cardsKept: 0, questionUses: {}, wideHeading: 42,
    station: { id: 'station', name: 'Station', position: { lat: 37.78, lng: -122.44 } },
    spot: { lat: 37.779, lng: -122.441 }, panorama: { id: 'pano', date: '2026-01' },
    stationPanorama: { id: 'station-pano', date: '2026-01' },
    route: { durationSeconds: 1200, distanceMeters: 4000, departureTime: '2026-08-24T19:00:00.000Z', arrivalTime: '2026-08-24T19:20:00.000Z', summary: ['Walk', 'N', 'Walk'] },
    deck: createDeck(() => 0.5), questionNumber: 0, activeEffects: [], blockedQuestionKeys: [], recentDecisions: [], publicMoves: [],
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

  // Reproduce the old writer for migration tests; the production writer now
  // compacts Labyrinth and refuses to issue tokens over its normal size limit.
  async function legacySeal(value: SecretSoloSession) {
    const encoder = new TextEncoder();
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(process.env.SOLO_SESSION_SECRET!));
    const key = await crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(value)));
    return `${Buffer.from(iv).toString('base64url')}.${Buffer.from(encrypted).toString('base64url')}`;
  }

  it('casts Labyrinth through the question API with a compact token and the full maze', async () => {
    const value = session();
    value.deck.drawPile = ['labyrinth#1'];
    const response = await questionHandler(new Request('https://example.test/api/solo/question', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: await seal(value), constraint: {
        id: 'radar', name: 'Radar · 1 mi', kind: 'radar', enabled: true, answer: 'yes', origin: value.spot, distanceMiles: 1,
      } }),
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.token.length).toBeLessThan(10_000);
    expect(body.cardState.activeCurses[0].mazeSvg).toBe(deterministicMazeSvg('session:1'));
    expect(body.cardState.activeCurses[0]).not.toHaveProperty('mazeSeed');
    const restored = await unseal<SecretSoloSession>(body.token, 'solo-session');
    expect(restored.activeEffects?.[0]).toMatchObject({ cardId: 'labyrinth', mazeSeed: 'session:1' });
    expect(restored.activeEffects?.[0]).not.toHaveProperty('mazeSvg');
    restored.questionNumber = 9;
    expect(publicCardState(restored).activeCurses[0].mazeSvg).toBe(body.cardState.activeCurses[0].mazeSvg);
  });

  it.each([false, true])('can pause, resume, and clear Labyrinth without changing its maze (legacy token: %s)', async (legacy) => {
    const value = session();
    value.questionNumber = 4;
    value.deck.hand = ['labyrinth#1'];
    value.deck.drawPile = value.deck.drawPile.filter((instance) => instance !== 'labyrinth#1');
    expect(playPostAnswerCard(value, 'labyrinth#1').played).toBe(true);
    const effect = value.activeEffects![0];
    const maze = publicCardState(value).activeCurses[0].mazeSvg;
    if (legacy) {
      effect.mazeSvg = maze;
      delete effect.mazeSeed;
    }
    let token = legacy ? await legacySeal(value) : await seal(value);
    if (legacy) expect(token.length).toBeGreaterThan(MAX_SOLO_TOKEN_LENGTH);
    for (const action of ['pause', 'resume'] as const) {
      const response = await clockHandler(new Request('https://example.test/api/solo/clock', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, action }),
      }));
      const body = await response.json();
      expect(response.status, JSON.stringify({ error: body.error })).toBe(200);
      expect(body.cardState.activeCurses[0].mazeSvg).toBe(maze);
      token = body.token;
      expect(token.length).toBeLessThan(MAX_SOLO_TOKEN_LENGTH);
      const restored = await unseal<SecretSoloSession>(token, 'solo-session');
      expect(restored.activeEffects![0]).toMatchObject({ mazeSeed: 'session:4' });
      expect(restored.activeEffects![0]).not.toHaveProperty('mazeSvg');
    }
    const cleared = await cardEventHandler(new Request('https://example.test/api/solo/card-event', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, event: { type: 'clear', effectId: effect.id } }),
    }));
    const body = await cleared.json();
    expect(cleared.status).toBe(200);
    expect(body.cardState.activeCurses).toEqual([]);
    expect(body.cardState.questionBlocked).toBe(false);
    expect((await unseal<SecretSoloSession>(body.token, 'solo-session')).activeEffects).toEqual([]);
  });

  it('compacts recognized legacy mazes on write without mutating the caller', async () => {
    const value = session();
    value.questionNumber = 1;
    value.deck.hand = ['labyrinth#1'];
    playPostAnswerCard(value, 'labyrinth#1');
    const effect = value.activeEffects![0];
    effect.mazeSvg = deterministicMazeSvg('session:1');
    delete effect.mazeSeed;
    const token = await seal(value);
    expect(token.length).toBeLessThan(MAX_SOLO_TOKEN_LENGTH);
    expect(effect.mazeSvg).toBeTruthy();
    expect((await unseal<SecretSoloSession>(token, 'solo-session')).activeEffects![0].mazeSeed).toBe('session:1');
  });

  it('does not turn legacy maze recovery into a general oversized-token bypass', async () => {
    const value = session();
    value.recentDecisions = ['x'.repeat(MAX_SOLO_TOKEN_LENGTH)];
    await expect(seal(value)).rejects.toThrow(/too large/);
    await expect(unseal(await legacySeal(value), 'solo-session')).rejects.toThrow(/invalid|expired/);
    value.questionNumber = 1;
    value.deck.hand = ['labyrinth#1'];
    playPostAnswerCard(value, 'labyrinth#1');
    value.activeEffects![0].mazeSvg = deterministicMazeSvg('session:1');
    delete value.activeEffects![0].mazeSeed;
    await expect(unseal(await legacySeal(value), 'solo-session')).rejects.toThrow(/invalid|expired/);
    await expect(unseal('x'.repeat(200_001), 'solo-session')).rejects.toThrow(/too large/);
    await expect(unseal('x'.repeat(MAX_SOLO_TOKEN_LENGTH + 1), 'solo-photo')).rejects.toThrow(/too large/);
  });

  it('migrates exact custom-distance history into one custom card category', async () => {
    const value = session();
    value.questionUses = {
      'radar:2.750': 1,
      'radar:7.000': 2,
      'radar:1.000': 1,
      'thermometer:2.000': 1,
    };
    const restored = await unseal<SecretSoloSession>(await seal(value), 'solo-session');
    expect(restored.questionUses).toEqual({
      'radar:custom': 3,
      'radar:1.000': 1,
      'thermometer:custom': 1,
    });
  });

  it('rejects pre-audit version-2 sessions that lack the current public card state', async () => {
    const obsolete = { ...session(), publicMoves: undefined } as unknown as SecretSoloSession;
    await expect(unseal<SecretSoloSession>(await seal(obsolete), 'solo-session')).rejects.toThrow(/invalid|expired/i);
  });

  it('reveals the current hider location without ending the game', async () => {
    const value = session();
    const response = await revealHandler(new Request('https://example.test/api/solo/reveal', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: await seal(value) }),
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.phase).toBe('seeking');
    expect(body.reveal.reason).toBe('peek');
    expect(body.reveal.spot).toEqual(value.spot);
    await expect(unseal<SecretSoloSession>(body.token, 'solo-session')).resolves.toEqual(expect.objectContaining({ phase: 'seeking' }));
  });

  it('keeps the hiding clock running continuously in an AI game', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T12:05:00.000Z'));
    const value = session();
    value.createdAt = '2026-08-25T12:00:00.000Z';
    value.expiresAt = '2026-08-26T12:00:00.000Z';
    const token = await seal(value);
    const revealed = await revealHandler(new Request('https://example.test/api/solo/reveal', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
    }));
    const revealedBody = await revealed.json();
    expect(revealedBody.reveal.elapsedHidingSeconds).toBe(300);
  });

  it('pauses active time and shifts curse deadlines when resumed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T12:05:00.000Z'));
    const value = session();
    value.createdAt = '2026-08-25T12:00:00.000Z';
    value.expiresAt = '2026-08-26T12:00:00.000Z';
    value.activeEffects = [{
      id: 'right', cardId: 'right-turn', cardInstance: 'right-turn#1', name: 'Curse of the Right Turn',
      description: 'Turn right.', status: 'active', startedQuestion: 1, blocksQuestions: false, blocksTransit: false,
      completionInstruction: 'Wait.', expiresAt: '2026-08-25T12:10:00.000Z',
    }];
    const pause = await clockHandler(new Request('https://example.test/api/solo/clock', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: await seal(value), action: 'pause' }),
    }));
    const paused = await pause.json();
    expect(paused.clock).toMatchObject({ elapsedSeconds: 300, pauseCount: 1 });
    const blockedQuestion = await questionHandler(new Request('https://example.test/api/solo/question', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: paused.token, constraint: {
        id: 'radar', name: 'Radar', kind: 'radar', enabled: false, answer: 'yes',
        origin: { lat: 37.77, lng: -122.44 }, distanceMiles: 1,
      } }),
    }));
    expect(blockedQuestion.status).toBe(409);
    vi.setSystemTime(new Date('2026-08-25T12:10:00.000Z'));
    const peek = await revealHandler(new Request('https://example.test/api/solo/reveal', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: paused.token }),
    }));
    expect((await peek.json()).reveal.elapsedHidingSeconds).toBe(300);
    const resume = await clockHandler(new Request('https://example.test/api/solo/clock', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: paused.token, action: 'resume' }),
    }));
    const resumed = await resume.json();
    const restored = await unseal<SecretSoloSession>(resumed.token, 'solo-session');
    expect(restored.totalPausedSeconds).toBe(300);
    expect(restored.activeEffects?.[0].expiresAt).toBe('2026-08-25T12:15:00.000Z');
    expect(formatElapsedTime(resumed.clock.elapsedSeconds)).toBe('5:00');
  });

  it('lets seekers veto an infeasible physical curse and rolls back its free-question benefit', async () => {
    const value = session();
    value.freeNextQuestion = true;
    value.deck.usedPile = ['impressionable-consumer#1'];
    value.activeEffects = [{
      id: 'consumer', cardId: 'impressionable-consumer', cardInstance: 'impressionable-consumer#1',
      name: 'Curse of the Impressionable Consumer', description: 'Act on an advertisement.', status: 'active',
      startedQuestion: 1, blocksQuestions: true, blocksTransit: false, completionInstruction: 'Complete the task.',
    }];
    const response = await cardEventHandler(new Request('https://example.test/api/solo/card-event', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: await seal(value), event: { type: 'veto-infeasible', effectId: 'consumer', reason: 'not-available' } }),
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.cardState.activeCurses).toEqual([]);
    expect(body.cardState.nextQuestionFree).toBe(false);
    const restored = await unseal<SecretSoloSession>(body.token, 'solo-session');
    expect(restored.deck.usedPile).not.toContain('impressionable-consumer#1');
    expect(restored.deck.discardPile).toContain('impressionable-consumer#1');
    expect(body.message).toMatch(/vetoed.*no bonus.*cooldown/i);
  });

  it('reports a newly kept card even when hand overflow discards an older card', async () => {
    const value = session();
    value.deck = {
      drawPile: ['time-12#1', 'time-2#1'],
      hand: ['cairn#1', 'luxury-car#1', 'ransom-note#1', 'bird-guide#1', 'zoologist#1', 'time-4#1'],
      discardPile: [], usedPile: [], maxHandSize: 6,
    };
    const response = await questionHandler(new Request('https://example.test/api/solo/question', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: await seal(value), constraint: {
        id: 'radar', name: 'Radar · 1 mi', kind: 'radar', enabled: true, answer: 'yes',
        origin: { lat: 37.77, lng: -122.44 }, distanceMiles: 1,
      } }),
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.cardsKept).toBe(1);
    expect(body.cardState.handCards).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'time-12' })]));
    expect(body.cardState.playHistory.join(' ')).toMatch(/discarded Curse of the Cairn for hand overflow/i);
  });

  it('supports an explicit resignation that ends and reveals the game', async () => {
    const value = session();
    const response = await revealHandler(new Request('https://example.test/api/solo/reveal', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: await seal(value), resign: true }),
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.phase).toBe('gave-up');
    expect(body.reveal.reason).toBe('gave-up');
    await expect(unseal<SecretSoloSession>(body.token, 'solo-session')).resolves.toEqual(expect.objectContaining({ phase: 'gave-up' }));
  });

  it('rejects attempts to clear the permanent Spotty Memory curse', async () => {
    const value = session();
    value.version = 2;
    value.spottyMemoryCategory = 'radar';
    value.activeEffects = [{
      id: 'spotty', cardId: 'spotty-memory', cardInstance: 'spotty-memory#1',
      name: 'Curse of Spotty Memory', description: 'A category is disabled.', status: 'active',
      startedQuestion: 1, blocksQuestions: false, blocksTransit: false, completionInstruction: 'Permanent.',
    }];
    const response = await cardEventHandler(new Request('https://example.test/api/solo/card-event', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: await seal(value), event: { type: 'clear', effectId: 'spotty' } }),
    }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ error: expect.stringMatching(/cannot be cleared/i) }));
  });

  it('keeps carried-item curses after the initial task and awards their printed condition once', async () => {
    const value = session();
    value.deck.hand = [];
    value.deck.usedPile = ['egg-partner#1'];
    value.activeEffects = [{
      id: 'egg', cardId: 'egg-partner', cardInstance: 'egg-partner#1', name: 'Curse of the Egg Partner',
      description: 'Acquire and protect an egg.', status: 'active', startedQuestion: 1,
      blocksQuestions: true, blocksTransit: false, failureBonusMinutes: 30,
      completionInstruction: 'Report when the egg is acquired.', failureInstruction: 'Report if the egg cracks.',
    }];
    const send = async (token: string, type: 'complete-task' | 'report-failure') => {
      const response = await cardEventHandler(new Request('https://example.test/api/solo/card-event', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, event: { type, effectId: 'egg' } }),
      }));
      return { response, body: await response.json() };
    };
    const completed = await send(await seal(value), 'complete-task');
    expect(completed.response.status).toBe(200);
    expect(completed.body.cardState.questionBlocked).toBe(false);
    expect(completed.body.cardState.activeCurses[0]).toEqual(expect.objectContaining({ status: 'monitoring', canReportFailure: true, canClear: false }));

    const failed = await send(completed.body.token, 'report-failure');
    expect(failed.response.status).toBe(200);
    expect(failed.body.cardState.activeCurses[0]).toEqual(expect.objectContaining({ status: 'failed', failureReported: true }));
    expect((await unseal<SecretSoloSession>(failed.body.token, 'solo-session')).bonusMinutes).toBe(30);

    const duplicate = await send(failed.body.token, 'report-failure');
    expect(duplicate.response.status).toBe(409);
  });

  it('does not let timed, automatic, Hangman, or persistent curses clear early', async () => {
    for (const [cardId, name] of [
      ['right-turn', 'Curse of the Right Turn'],
      ['overflowing-chalice', 'Curse of the Overflowing Chalice'],
      ['hidden-hangman', 'Curse of the Hidden Hangman'],
      ['urban-explorer', 'Curse of the Urban Explorer'],
    ] as const) {
      const value = session();
      value.activeEffects = [{
        id: cardId, cardId, cardInstance: `${cardId}#1`, name, description: 'Test effect', status: 'active',
        startedQuestion: 1, blocksQuestions: false, blocksTransit: false, completionInstruction: 'Automatic.',
      }];
      const response = await cardEventHandler(new Request('https://example.test/api/solo/card-event', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: await seal(value), event: { type: 'clear', effectId: cardId } }),
      }));
      expect(response.status, cardId).toBe(409);
    }
  });

  it.each([false, true])('accepts Distant Cuisine without relocating Xeno (legacy panorama: %s)', async (legacyPanorama) => {
    const value = session();
    value.questionNumber = 10;
    value.lastRelocationQuestionNumber = 2;
    value.positionRevision = 3;
    value.zonePhotoScenes = { anchor: 'unchanged-photo-cache', scenes: {} };
    value.movementHistory = [{ at: value.createdAt, reason: 'initial', station: value.station, position: value.spot }];
    const before = structuredClone(value);
    const destination = { lat: 37.7795, lng: -122.44 };
    value.activeEffects = [{
      id: 'cuisine', cardId: 'distant-cuisine', cardInstance: 'distant-cuisine#1', name: 'Curse of the Distant Cuisine',
      description: 'Visit qualifying cuisine.', status: 'pending', startedQuestion: 1, blocksQuestions: true, blocksTransit: false,
      placeName: 'Reference Restaurant', proposedPosition: destination,
      proposedPanorama: legacyPanorama ? { id: 'restaurant-pano' } : undefined,
      completionInstruction: 'Visit a qualifying restaurant.',
    }];
    const response = await cardEventHandler(new Request('https://example.test/api/solo/card-event', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: await seal(value), event: { type: 'accept-pending', effectId: 'cuisine' } }),
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    const updated = await unseal<SecretSoloSession>(body.token, 'solo-session');
    for (const field of ['spot', 'panorama', 'station', 'stationPanorama', 'route', 'lastRelocationQuestionNumber', 'positionRevision', 'movementHistory', 'zonePhotoScenes'] as const) {
      expect(updated[field], field).toEqual(before[field]);
    }
    expect(updated.activeEffects?.[0]).toMatchObject({ status: 'active', proposedPosition: destination });
    expect(body.cardState.positionRevision).toBe(3);
    expect(body.message).toContain('Xeno has not moved');
  });

  it('rejects a Distant Cuisine reference restaurant outside the hiding zone', async () => {
    const value = session();
    value.activeEffects = [{
      id: 'unsafe-cuisine', cardId: 'distant-cuisine', cardInstance: 'distant-cuisine#1', name: 'Curse of the Distant Cuisine',
      description: 'Visit qualifying cuisine.', status: 'pending', startedQuestion: 1, blocksQuestions: true, blocksTransit: false,
      placeName: 'Outside Restaurant', proposedPosition: { lat: 37.776, lng: -122.408 },
      completionInstruction: 'Visit a qualifying restaurant.',
    }];
    const response = await cardEventHandler(new Request('https://example.test/api/solo/card-event', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: await seal(value), event: { type: 'accept-pending', effectId: 'unsafe-cuisine' } }),
    }));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/reference restaurant inside the hiding zone/i);
  });

  it('enforces both ten-minute Hidden Hangman waits', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T12:00:00.000Z'));
    const value = session();
    value.expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    value.activeEffects = [{
      id: 'hangman', cardId: 'hidden-hangman', cardInstance: 'hidden-hangman#1', name: 'Curse of the Hidden Hangman',
      description: 'Beat Hangman.', status: 'active', startedQuestion: 1, blocksQuestions: true, blocksTransit: true,
      completionInstruction: 'Solve Hangman.', hangmanWord: 'apple', hangmanWrong: [], hangmanGuesses: [], hangmanLosses: 0,
    }];
    const guess = async (token: string, value: string) => {
      const response = await cardEventHandler(new Request('https://example.test/api/solo/card-event', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, event: { type: 'hangman-guess', effectId: 'hangman', guess: value } }),
      }));
      return { response, body: await response.json() };
    };
    let token = await seal(value);
    for (const wrong of ['b', 'c', 'd', 'f', 'g', 'h', 'i']) token = (await guess(token, wrong)).body.token;
    const locked = await unseal<SecretSoloSession>(token, 'solo-session');
    expect(locked.activeEffects?.[0].hangmanLosses).toBe(1);
    expect(Date.parse(locked.activeEffects?.[0].lockedUntil ?? '')).toBe(Date.now() + 600_000);
    expect((await guess(token, 'j')).response.status).toBe(409);

    vi.advanceTimersByTime(600_001);
    for (const wrong of ['b', 'c', 'd', 'f', 'g', 'h', 'i']) token = (await guess(token, wrong)).body.token;
    const finalWait = await unseal<SecretSoloSession>(token, 'solo-session');
    expect(finalWait.activeEffects?.[0].status).toBe('waiting');
    expect(Date.parse(finalWait.activeEffects?.[0].expiresAt ?? '')).toBe(Date.now() + 600_000);
    vi.advanceTimersByTime(600_001);
    expect(publicCardState(finalWait).activeCurses).toEqual([]);
  });

  it('generates Randomize candidates for Matching and Tentacles without inventing missing transit context', () => {
    const value = session();
    const matching = randomizeCandidates({
      id: 'matching', name: 'Matching · Museum', kind: 'matching-region', enabled: true, answer: 'yes',
      origin: value.spot, category: 'museum',
    }, value);
    expect(matching.length).toBeGreaterThan(5);
    expect(matching.some((candidate) => candidate.category === 'transit-route')).toBe(false);
    expect(matching.some((candidate) => candidate.category === 'zip-code')).toBe(true);
    expect(matching.every((candidate) => candidate.kind === 'matching-region' && candidate.category !== 'museum')).toBe(true);
    const consulateReplacement = matching.find((candidate) => candidate.category === 'foreign-consulate')!;
    expect(consulateReplacement.regionId).toMatch(/^sf:foreign-consulate:/);

    const libraryOriginal = {
      id: 'library', name: 'Matching · Library', kind: 'matching-region' as const, enabled: true, answer: 'yes' as const,
      origin: { lat: 37.71, lng: -122.52 }, category: 'library',
    };
    const consulateAtSamePin = { ...consulateReplacement, origin: libraryOriginal.origin };
    const hiddenPosition = { lat: 37.71, lng: -122.49 };
    expect(solveHiderQuestion(libraryOriginal, hiddenPosition).answer).toBe('no');
    expect(solveHiderQuestion(consulateAtSamePin, hiddenPosition).answer).toBe('yes');

    value.blockedQuestionKeys = [canonicalQuestionKey(matching[0])];
    expect(randomizeCandidates({
      id: 'matching-2', name: 'Matching · Museum', kind: 'matching-region', enabled: true, answer: 'yes',
      origin: value.spot, category: 'museum',
    }, value)).not.toContainEqual(expect.objectContaining({ category: matching[0].category }));

    const tentacles = randomizeCandidates({
      id: 'tentacle', name: 'Tentacles · Museum', kind: 'tentacle', enabled: true, answer: 'yes',
      origin: value.spot, category: 'museum', distanceMiles: 1,
    }, value);
    expect(tentacles.map((candidate) => candidate.category)).toEqual(['library', 'movie-theater', 'hospital']);
    expect(tentacles.some((candidate) => candidate.category === 'aquarium')).toBe(false);
    expect(tentacles.some((candidate) => candidate.category === 'transit-route')).toBe(false);
  });

  it('supplies the actual nearby Street View scene when Unguided Tourist is played', async () => {
    const value = session();
    value.deck = { drawPile: ['time-2#1', 'time-4#1'], hand: ['unguided-tourist#1'], discardPile: [], usedPile: [], maxHandSize: 6 };
    value.gemini = {
      calls: 0, mapsCalls: 0, inputTokens: 0, outputTokens: 0, spentMicros: 0,
      reservedMapsMicros: 0, recentCallTimes: [], fallback: false,
    };
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.GOOGLE_MAPS_SERVER_API_KEY = 'maps-key';
    const interaction = Response.json({
      steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify({ keeps: [['time-2#1']], playCard: 'unguided-tourist#1' }) }] }],
      usage: { total_input_tokens: 50, total_output_tokens: 10 },
    });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ totalTokens: 50 }))
      .mockResolvedValueOnce(interaction)
      .mockResolvedValueOnce(Response.json({
        status: 'OK', pano_id: 'seeker-nearby-pano', date: '2026-01', location: value.spot,
      })));
    try {
      const response = await questionHandler(new Request('https://example.test/api/solo/question', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: await seal(value),
          constraint: { id: 'radar', name: 'Radar · 1 mi', kind: 'radar', enabled: true, answer: 'yes', origin: value.spot, distanceMiles: 1 },
        }),
      }));
      const body = await response.json();
      expect(response.status).toBe(200);
      const effect = body.cardState.activeCurses.find((candidate: { cardId: string }) => candidate.cardId === 'unguided-tourist');
      expect(effect).toEqual(expect.objectContaining({ status: 'pending', imageUrl: expect.stringContaining('/api/solo/photo?token=') }));
      expect(effect.detail).toMatch(/within 500 feet/i);
      const assetToken = new URL(effect.imageUrl, 'https://example.test').searchParams.get('token');
      await expect(unseal<PhotoAsset>(assetToken!, 'solo-photo')).resolves.toEqual(expect.objectContaining({ panoramaId: 'seeker-nearby-pano', pitch: 0, fov: 120 }));
    } finally {
      vi.unstubAllGlobals();
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_MAPS_SERVER_API_KEY;
    }
  });

  it('rejects obsolete version-1 Solo session tokens', async () => {
    const obsolete = { ...session(), version: 1 } as unknown as SecretSoloSession;
    await expect(unseal<SecretSoloSession>(await seal(obsolete), 'solo-session')).rejects.toThrow(/invalid|expired/i);
  });

  it('keeps the hidden position encrypted while rotating question state and repetition costs', async () => {
    const value = session();
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
    expect(firstBody.questionUses).toEqual({ 'radar:1.000': 1 });
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
    expect(secondBody.questionUses).toEqual({ 'radar:1.000': 2 });
  });

  it('announces Randomize and returns the replacement that was actually answered', async () => {
    const value = session();
    value.version = 2;
    value.questionNumber = 0;
    value.activeEffects = [];
    value.blockedQuestionKeys = [];
    value.recentDecisions = [];
    value.deck = {
      drawPile: ['time-2#1', 'time-4#1'],
      hand: ['randomize#1'],
      discardPile: [], usedPile: [], maxHandSize: 6,
    };
    value.gemini = {
      calls: 0, mapsCalls: 0, inputTokens: 0, outputTokens: 0, spentMicros: 0,
      reservedMapsMicros: 0, recentCallTimes: [], fallback: false,
    };
    process.env.GEMINI_API_KEY = 'test-key';
    const interaction = (result: object) => Response.json({
      steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(result) }] }],
      usage: { total_input_tokens: 50, total_output_tokens: 10 },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ totalTokens: 50 }))
      .mockResolvedValueOnce(interaction({ action: 'randomize', card: 'randomize#1' }))
      .mockResolvedValueOnce(Response.json({ totalTokens: 50 }))
      .mockResolvedValueOnce(interaction({ keeps: [['time-2#1']], playCard: null }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const original = {
        id: 'q', name: 'Radar · 0.25 mi', kind: 'radar' as const, enabled: true, answer: 'yes' as const,
        answerSet: true, origin: value.spot, originSet: true, distanceMiles: 0.25,
      };
      const response = await questionHandler(new Request('https://example.test/api/solo/question', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: await seal(value), constraint: original }),
      }));
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.outcome).toBe('randomized');
      expect(body.replacementConstraint.distanceMiles).not.toBe(original.distanceMiles);
      expect(body.answeredConstraintPatch).toMatchObject({
        distanceMiles: body.replacementConstraint.distanceMiles,
        answer: body.answer,
        answerSet: true,
      });
      expect(body.answeredConstraintPatch).not.toHaveProperty('origin');
      expect(body.randomizedFrom).toBe(original.name);
      expect(body.randomizedTo).toBe(body.replacementConstraint.name);
      expect(body.playedCardAnnouncements).toContain(`Xeno played Randomize question: “${original.name}” was replaced with “${body.replacementConstraint.name}”.`);
      expect(body.cardState.playHistory.join(' ')).toMatch(/played Randomize question.*was replaced with/i);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.GEMINI_API_KEY;
    }
  });

  it('announces Veto, gives no answer or reward, and still counts the question as asked', async () => {
    const value = session();
    value.version = 2;
    value.questionNumber = 0;
    value.activeEffects = [];
    value.blockedQuestionKeys = [];
    value.recentDecisions = [];
    value.deck = { drawPile: ['time-2#1'], hand: ['veto#1'], discardPile: [], usedPile: [], maxHandSize: 6 };
    value.gemini = {
      calls: 0, mapsCalls: 0, inputTokens: 0, outputTokens: 0, spentMicros: 0,
      reservedMapsMicros: 0, recentCallTimes: [], fallback: false,
    };
    process.env.GEMINI_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ totalTokens: 50 }))
      .mockResolvedValueOnce(Response.json({
        steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify({ action: 'veto', card: 'veto#1' }) }] }],
        usage: { total_input_tokens: 50, total_output_tokens: 10 },
      })));
    try {
      const constraint = {
        id: 'q', name: 'Radar · 1 mi', kind: 'radar' as const, enabled: true, answer: 'yes' as const,
        answerSet: true, origin: value.spot, originSet: true, distanceMiles: 1,
      };
      const response = await questionHandler(new Request('https://example.test/api/solo/question', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: await seal(value), constraint }),
      }));
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body).toEqual(expect.objectContaining({
        outcome: 'vetoed', displayText: 'Question vetoed — no answer or card reward.', cardsDrawn: 0, cardsKept: 0,
      }));
      expect(body.answer).toBeUndefined();
      expect(body.playedCardAnnouncements).toEqual(['Xeno played Veto question.']);
      expect(body.questionUses).toEqual({ 'radar:1.000': 1 });
      const sealed = await unseal<SecretSoloSession>(body.token, 'solo-session');
      expect(sealed.questionUses[canonicalQuestionKey(constraint)]).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.GEMINI_API_KEY;
    }
  });

  it.each([
    ['veto', false], ['veto', true], ['randomize', false], ['randomize', true],
  ] as const)('charges %s to the normal allowance only when it is not copied (%s)', async (action, copied) => {
    const value = session();
    const source = `${action}#1` as const;
    value.deck = {
      drawPile: ['time-2#1', 'time-2#2', 'time-2#3'],
      hand: [source, 'expand-hand#1', ...(copied ? ['duplicate#1' as const] : [])],
      discardPile: [], usedPile: [], maxHandSize: 6,
    };
    value.gemini = { calls: 0, mapsCalls: 0, inputTokens: 0, outputTokens: 0, spentMicros: 0, reservedMapsMicros: 0, recentCallTimes: [], fallback: false };
    process.env.GEMINI_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('countTokens')) return Response.json({ totalTokens: 50 });
      const prompt = JSON.parse(JSON.parse(String(init?.body)).input);
      const result = prompt.legal ? { action, card: source } : {
        keeps: prompt.state.drawGroups.map((group: { keep: number; cards: { instance: string }[] }) => group.cards.slice(0, group.keep).map((card) => card.instance)),
        playCard: 'expand-hand#1',
      };
      return Response.json({ output_text: JSON.stringify(result) });
    }));
    try {
      const response = await questionHandler(new Request('https://example.test/api/solo/question', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: await seal(value), constraint: {
          id: 'q', name: 'Radar · 1 mi', kind: 'radar', enabled: true, answer: 'yes', origin: value.spot, distanceMiles: 1,
        } }),
      }));
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.outcome).toBe(action === 'veto' ? 'vetoed' : 'randomized');
      const restored = await unseal<SecretSoloSession>(body.token, 'solo-session');
      expect(restored.deck.usedPile).toEqual(copied ? ['duplicate#1', 'expand-hand#1'] : [source]);
      expect(restored.deck.maxHandSize).toBe(copied ? 7 : 6);
      expect(body.playedCardAnnouncements).toHaveLength(copied ? 2 : 1);
      if (copied) expect(restored.deck.hand).toContain(source);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.GEMINI_API_KEY;
    }
  });

  it('plays a free Duplicate between questions after a blocking curse is cleared', async () => {
    const value = session();
    value.questionNumber = 1;
    value.deck = { drawPile: [], hand: ['luxury-car#1', 'duplicate#1', 'bird-guide#1'], discardPile: [], usedPile: [], maxHandSize: 6 };
    expect(playPostAnswerCard(value, 'luxury-car#1').played).toBe(true);
    const response = await cardEventHandler(new Request('https://example.test/api/solo/card-event', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: await seal(value), event: { type: 'clear', effectId: value.activeEffects![0].id } }),
    }));
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    const restored = await unseal<SecretSoloSession>(body.token, 'solo-session');
    expect(restored.questionNumber).toBe(1);
    expect(restored.lastCurseQuestionNumber).toBe(1);
    expect(restored.deck.usedPile).toEqual(['luxury-car#1', 'duplicate#1']);
    expect(restored.deck.hand).toEqual(['bird-guide#1']);
    expect(body.playedCardAnnouncements).toEqual([expect.stringContaining('Duplicate another card as Curse of the Bird Guide')]);
    expect(body.cardState.activeCurses).toEqual([expect.objectContaining({ cardId: 'bird-guide' })]);
  });

  it('does not immediately replay a copied curse vetoed as unsafe', async () => {
    const value = session();
    value.questionNumber = 1;
    value.deck = { drawPile: [], hand: ['bird-guide#1', 'duplicate#1', 'duplicate#2'], discardPile: [], usedPile: [], maxHandSize: 6 };
    expect(playPostAnswerCard(value, 'duplicate#1').played).toBe(true);
    const response = await cardEventHandler(new Request('https://example.test/api/solo/card-event', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: await seal(value), event: { type: 'veto-infeasible', effectId: value.activeEffects![0].id, reason: 'unsafe' } }),
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    const restored = await unseal<SecretSoloSession>(body.token, 'solo-session');
    expect(restored.deck.hand).toEqual(['bird-guide#1', 'duplicate#2']);
    expect(restored.activeEffects).toEqual([]);
    expect(restored.lastCurseQuestionNumber).toBeUndefined();
    expect(body.message).toContain('Duplicate did not use the normal card allowance');
    expect(body.playedCardAnnouncements).toEqual([]);
  });

  it('issues station and hiding-spot photos from separate panoramas with distinct cameras', async () => {
    const value = session();
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
    const spotPhoto = await askPhoto('the-sky');
    expect(stationPhoto.asset.panoramaId).toBe('station-pano');
    expect(stationPhoto.body.displayText).toMatch(/at the central station/);
    expect(otherStationPhoto.asset.heading).not.toBe(stationPhoto.asset.heading);
    expect(spotPhoto.asset.panoramaId).toBe('pano');
    expect(spotPhoto.body.displayText).toMatch(/at the hiding location/);
  });

  it('returns a sealed, coordinate-free nearest-street orientation graphic', async () => {
    const value = session();
    const response = await questionHandler(new Request('https://example.test/api/solo/question', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: await seal(value),
        constraint: {
          id: 'trace', name: 'Trace nearest street/path', kind: 'photo-reference', enabled: true,
          answer: 'yes', origin: value.spot, category: 'trace-nearest-street-path',
        },
      }),
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.displayText).toMatch(/approximate nearest named-street orientation/i);
    expect(body.photoUrl).toMatch(/^\/api\/solo\/street-orientation\?token=/);
    const assetToken = new URL(body.photoUrl, 'https://example.test').searchParams.get('token')!;
    const asset = await unseal<StreetOrientationAsset>(assetToken, 'solo-street-orientation');
    expect(asset.bearing).toBeGreaterThanOrEqual(0);
    expect(asset.bearing).toBeLessThan(180);

    const image = await streetOrientationHandler(new Request(new URL(body.photoUrl, 'https://example.test')));
    const svg = await image.text();
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toMatch(/^image\/svg\+xml/);
    expect(svg).toContain('Approximate nearest-street orientation');
    expect(svg).not.toContain(String(value.spot.lat));
    expect(svg).not.toContain(String(value.spot.lng));
  });

  it('renders diagonal street bearings without aspect-ratio distortion', () => {
    expect(streetOrientationSvg(45)).toContain('x1="204.54" y1="320.46" x2="395.46" y2="129.54"');
  });

  it('aims a Street View photo at a mapped park inside the hiding zone', async () => {
    const value = session();
    value.station = {
      id: 'park-zone', name: 'Park zone',
      position: { lat: 37.7762, lng: -122.4355 },
    };
    value.spot = { lat: 37.776, lng: -122.435 };
    process.env.GOOGLE_MAPS_SERVER_API_KEY = 'maps-key';
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ places: [{
        id: 'alamo-square', displayName: { text: 'Alamo Square' }, userRatingCount: 10,
        location: { latitude: 37.7761473640493, longitude: -122.435480752366 },
      }] }))
      .mockResolvedValueOnce(Response.json({
        status: 'OK', pano_id: 'park-pano', date: '2026-01',
        location: { lat: 37.7761, lng: -122.4357 },
      })));
    try {
      const response = await questionHandler(new Request('https://example.test/api/solo/question', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: await seal(value),
          constraint: {
            id: 'photo-park', name: 'Park', kind: 'photo-reference', enabled: true,
            answer: 'yes', origin: value.spot, category: 'park',
          },
        }),
      }));
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.displayText).toMatch(/qualifying park in the hiding zone/i);
      expect(body.displayText).not.toContain('Alamo Square');
      const assetToken = new URL(body.photoUrl, 'https://example.test').searchParams.get('token');
      const asset = await unseal<PhotoAsset>(assetToken!, 'solo-photo');
      expect(asset).toEqual(expect.objectContaining({ panoramaId: 'park-pano', pitch: 0, fov: 90 }));
      expect(Number.isFinite(asset.heading)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.GOOGLE_MAPS_SERVER_API_KEY;
    }
  });

  it('gives no reward when Street View cannot technically supply the photo', async () => {
    const value = session();
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
    expect(body.cardsDrawn).toBe(0);
    expect(body.cardsKept).toBe(0);
  });

  it('rejects removed photo subjects that are not in the SF deck', async () => {
    const value = session();
    value.station = { id: 'inland', name: 'Inland station', position: { lat: 37.76, lng: -122.44 } };
    value.spot = { lat: 37.76, lng: -122.44 };
    const response = await questionHandler(new Request('https://example.test/api/solo/question', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: await seal(value),
        constraint: {
          id: 'photo-water', name: 'Biggest body of water', kind: 'photo-reference', enabled: true,
          answer: 'yes', origin: value.spot, category: 'biggest-body-of-water-in-your-zone',
        },
      }),
    }));
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toMatch(/invalid/i);
  });

  it('serves the selfie easter egg without drawing or keeping cards', async () => {
    const value = session();
    const response = await questionHandler(new Request('https://example.test/api/solo/question', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: await seal(value),
        constraint: {
          id: 'photo-selfie', name: 'You', kind: 'photo-reference', enabled: true,
          answer: 'yes', origin: value.spot, category: 'you',
        },
      }),
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.displayText).toMatch(/identity successfully concealed/i);
    expect(body.photoUrl).toBe('/solo-selfie.svg');
    expect(body.cardsDrawn).toBe(0);
    expect(body.cardsKept).toBe(0);
    expect(body.totalCardsDrawn).toBe(0);
    expect(body.totalCardsKept).toBe(0);
  });

  it('starts end game for an in-zone pin and charges exactly one card for a miss', async () => {
    const value = session();
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

  it('answers transit matching from the current hiding station, not the nearest station to the hiding spot', async () => {
    const rapidStop = validStations.find((station) => station.name === 'Geary Blvd & 6th Ave')!;
    const localOnlyStop = validStations.find((station) => station.name === 'V.A. Hospital')!;
    const value = session();
    value.station = { id: rapidStop.id, name: rapidStop.name, position: rapidStop };
    value.spot = localOnlyStop;
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
