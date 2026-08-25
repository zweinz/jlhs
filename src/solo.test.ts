import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chunk, reachableStations, verifyTransitRoute } from '../api/_solo-google';
import { commitmentFor, seal, unseal, type SecretSoloSession } from '../api/_solo-session';
import questionHandler from '../api/solo/question';
import checkLocationHandler from '../api/solo/check-location';
import {
  cardsForQuestion,
  canonicalQuestionKey,
  keptCardsForQuestion,
  keptCardsFromQuestionUses,
  photoCamera,
  publicSoloDisplayText,
  sfLocalDateTimeToIso,
  stationDifficulty,
  verifyRevealCommitment,
  type SoloReveal,
} from './solo';

describe('Solo question accounting', () => {
  it('multiplies draw costs for repeated cards', () => {
    const radar = { kind: 'radar' as const, distanceMiles: 1 };
    const measuring = { kind: 'measuring' as const, category: 'museum' };
    const photo = { kind: 'photo-reference' as const, category: 'cardinal-view' };
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

  it('uses fixed API-native camera definitions', () => {
    expect(photoCamera('cardinal-view', spot, station, 'east')).toEqual({ heading: 90, pitch: 0, fov: 90 });
    expect(photoCamera('sky-above', spot, station)).toEqual({ heading: 0, pitch: 90, fov: 90 });
    expect(photoCamera('ground-and-path', spot, station).pitch).toBe(-45);
    expect(photoCamera('wide-streetscape', spot, station, 'north', 725)).toEqual({ heading: 5, pitch: 0, fov: 120 });
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
    )).rejects.toThrow(/daily limit has been reached/i);
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
    salt: 'salt', commitment: '', phase: 'seeking', cardsDrawn: 0, questionUses: {}, wideHeading: 42,
    station: { id: 'station', name: 'Station', position: { lat: 37.78, lng: -122.44 } },
    spot: { lat: 37.779, lng: -122.441 }, panorama: { id: 'pano', date: '2026-01' },
    route: { durationSeconds: 1200, distanceMeters: 4000, departureTime: '2026-08-24T19:00:00.000Z', arrivalTime: '2026-08-24T19:20:00.000Z', summary: ['Walk', 'N', 'Walk'] },
  });

  it('round trips encrypted sessions and rejects tampering', async () => {
    const value = session();
    const token = await seal(value);
    await expect(unseal<SecretSoloSession>(token, 'solo-session')).resolves.toEqual(value);
    const tamperedToken = `${token.slice(0, -1)}${token.endsWith('x') ? 'y' : 'x'}`;
    await expect(unseal<SecretSoloSession>(tamperedToken, 'solo-session')).rejects.toThrow(/invalid|expired/i);
  });

  it('verifies the public reveal against the original commitment', async () => {
    const value = session();
    value.commitment = await commitmentFor(value);
    const reveal: SoloReveal = {
      reason: 'found', station: value.station, spot: value.spot,
      panorama: { ...value.panorama, imageUrl: '/api/solo/photo?token=opaque' }, route: value.route,
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
