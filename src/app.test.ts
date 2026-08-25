import { describe, expect, it } from 'vitest';
import * as turf from '@turf/turf';
import { excludeAllExcept, setAllConstraintsEnabled, stationStatusesForAll, statusesForAll } from './bulkActions';
import { PARTITION_CATEGORIES, pois, provenance, validatePois } from './data';
import { activePoiPartition, selectPoiPartition, VISIBLE_POI_PARTITIONS } from './layers';
import { combineConstraints, constraintArea, excludedArea, partition, sfFrame, stationIdsOverlappingArea, stationZoneArea } from './geometry';
import { hiderAnswer } from './hider';
import { orderedRuleNotes, PRIMARY_QUESTION_KINDS, QUESTION_DEFINITIONS } from './questions';
import { MATCHING_SUBJECTS, MEASURING_SUBJECTS, PHOTO_SUBJECTS, selectableSubjects } from './rulebook';
import { districtAt, elevationAt, landmassAt, nearestStreet, nearestWaterDistance, supervisorDistricts, zipCodeAreas, zipCodeAt } from './rulebookGeometry';
import { pathDistanceMiles, pathGeoJson } from './trace';
import { decodeState, encodeState, validateState } from './share';
import { eligibleStationIds, otherTransitRoutes, primaryTransitRoutes, primaryTransitStationIds, shouldDisplayStationZone, transitRouteLabel, transitRoutes, validStations } from './transit';
import type { Constraint, SharedState } from './types';

const base = (kind: Constraint['kind']): Constraint => ({
  id: 'x',
  name: 'test',
  kind,
  enabled: true,
  answer: 'yes',
  origin: { lat: 37.77, lng: -122.44 },
  target: { lat: 37.78, lng: -122.42 },
  distanceMiles: 1,
  direction: 'north',
  category: 'museum',
});

describe('SF normalization', () => {
  it('accepts only unique, bounded, stable source records', () => {
    expect(validatePois()).toBe(true);
    expect(() => validatePois([...pois, { ...pois[0] }])).toThrow();
  });
  it('retains every complete source row and provenance field', () => {
    expect(pois).toHaveLength(3760);
    expect(provenance.totalPois).toBe(pois.length);
    expect(pois.every((poi) => poi.sourceSheet && poi.sourceObjectId && poi.sourceRow >= 2)).toBe(true);
    expect(pois.filter((poi) => poi.category === 'museum')).toHaveLength(49);
    expect(pois.filter((poi) => poi.category === 'library')).toHaveLength(29);
    expect(validStations).toHaveLength(193);
  });
});

it('shows hiding-zone radii only for eligible stations', () => {
  expect(shouldDisplayStationZone(true, true)).toBe(true);
  expect(shouldDisplayStationZone(true, false)).toBe(false);
  expect(shouldDisplayStationZone(false, true)).toBe(false);
});

describe.each(['radar', 'thermometer', 'measuring', 'coastline', 'direction', 'closer', 'farther', 'intersection', 'exclusion'] as const)(
  '%s geometry',
  (kind) => {
    it('produces geographic area', () => {
      const answer = kind === 'thermometer' ? 'colder' : kind === 'measuring' || kind === 'coastline' ? 'closer' : 'yes';
      expect(turf.area(constraintArea({ ...base(kind), answer }))).toBeGreaterThan(0);
    });
  },
);

it('uses a true thermometer bisector rather than a distance radius', () => {
  const constraint = { ...base('thermometer'), answer: 'warmer' as const };
  const area = constraintArea(constraint);
  expect(turf.booleanPointInPolygon([-122.41, 37.78], area)).toBe(true);
  expect(turf.booleanPointInPolygon([-122.46, 37.76], area)).toBe(false);
});

it('uses named matching regions', () => {
  const regions = partition('museum');
  const id = Object.keys(regions)[0];
  expect(turf.area(constraintArea({ ...base('matching-region'), regionId: id }, regions))).toBeGreaterThan(0);
});

describe('SF rulebook audit', () => {
  it('uses the exact question draw/pick costs without inventing rewards', () => {
    expect(QUESTION_DEFINITIONS.tentacle.drawInstruction).toBe('Draw 4, keep 2');
    expect(QUESTION_DEFINITIONS.measuring.drawInstruction).toBe('Draw 3, keep 1');
    expect(QUESTION_DEFINITIONS['matching-region'].drawInstruction).toBe('Draw 3, keep 1');
    expect(QUESTION_DEFINITIONS.radar.drawInstruction).toBe('Draw 2, keep 1');
    expect(QUESTION_DEFINITIONS['photo-reference'].drawInstruction).toBe('Draw 1, keep 1');
    expect(Object.values(QUESTION_DEFINITIONS).every((definition) => !('reward' in definition))).toBe(true);
  });

  it('catalogs the complete investigation-book inventories and SF decisions', () => {
    expect(MATCHING_SUBJECTS).toHaveLength(20);
    expect(MEASURING_SUBJECTS).toHaveLength(20);
    expect(PHOTO_SUBJECTS).toHaveLength(18);
    expect([...MATCHING_SUBJECTS, ...MEASURING_SUBJECTS, ...PHOTO_SUBJECTS].some((subject) => /homebrew/i.test(subject.label))).toBe(false);
    expect(MATCHING_SUBJECTS.find((subject) => subject.id === 'aquarium')?.status).toBe('out-of-play');
    expect(MEASURING_SUBJECTS.find((subject) => subject.id === 'aquarium')?.status).toBe('in-play');
    expect(selectableSubjects(MEASURING_SUBJECTS).some((subject) => subject.id === 'sea-level')).toBe(true);
    expect([...MATCHING_SUBJECTS, ...MEASURING_SUBJECTS].filter((subject) => subject.status === 'in-play').every((subject) => subject.support !== 'not-mapped')).toBe(true);
  });

  it('includes every medium-game photo card with its card-specific instructions', () => {
    const sfPhotos = PHOTO_SUBJECTS.filter((subject) => subject.status === 'in-play');
    expect(sfPhotos).toHaveLength(14);
    expect(sfPhotos.every((subject) => subject.notes.length > 0)).toBe(true);
    expect(sfPhotos.find((subject) => subject.id === 'restaurant-interior')?.notes.join(' ')).toMatch(/window/i);
    expect(sfPhotos.find((subject) => subject.id === 'tallest-building-visible-from-station')?.notes.join(' ')).toMatch(/upper third/i);
    expect(sfPhotos.find((subject) => subject.id === 'train-platform')?.notes.join(' ')).toMatch(/5×5/i);
  });

  it('records the custom radar and thermometer game modifications', () => {
    expect(QUESTION_DEFINITIONS.radar.notes.join(' ')).toMatch(/custom radar/i);
    expect(QUESTION_DEFINITIONS.thermometer.notes.join(' ')).toMatch(/custom thermometer/i);
  });
});

describe('missing measuring and matching geometry', () => {
  it('models sea-level, named water, and seeker-pin coastline comparisons', () => {
    const sea = constraintArea({ ...base('measuring'), category: 'sea-level', answer: 'closer' });
    const water = constraintArea({ ...base('measuring'), category: 'body-of-water', answer: 'closer' });
    const coastWest = constraintArea({ ...base('measuring'), category: 'coastline', origin: { lat: 37.76, lng: -122.50 }, answer: 'closer' });
    const coastCenter = constraintArea({ ...base('measuring'), category: 'coastline', origin: { lat: 37.76, lng: -122.44 }, answer: 'closer' });
    expect(turf.area(sea)).toBeGreaterThan(0);
    expect(turf.area(water)).toBeGreaterThan(0);
    expect(Math.abs(turf.area(coastWest) - turf.area(coastCenter))).toBeGreaterThan(1000);
    expect(elevationAt({ lat: 37.75, lng: -122.45 })).toBeTypeOf('number');
    expect(nearestWaterDistance({ lat: 37.75, lng: -122.45 })).toBeGreaterThanOrEqual(0);
  }, 15_000);

  it('models name-length, street, district, and landmass matching', () => {
    const stationRegions = partition('game-valid-station');
    for (const category of ['station-name-length', 'street-path', 'supervisor-district', 'landmass']) {
      expect(turf.area(constraintArea({ ...base('matching-region'), category }, stationRegions))).toBeGreaterThan(0);
    }
    expect(nearestStreet(base('radar').origin)).toBeTruthy();
    expect(districtAt(base('radar').origin)?.properties.name).toMatch(/District/);
    expect(landmassAt(base('radar').origin)?.properties.name).toBeTruthy();
  });

  it('models the requested ZIP-code matching level with complete merged regions', () => {
    expect(zipCodeAreas.features).toHaveLength(27);
    expect(new Set(zipCodeAreas.features.map((feature) => feature.properties.name)).size).toBe(27);
    const constraint = { ...base('matching-region'), category: 'zip-code' };
    expect(turf.area(constraintArea(constraint))).toBeGreaterThan(0);
    expect(zipCodeAt(constraint.origin)?.properties.name).toMatch(/^941/);
    expect(hiderAnswer(constraint, { lat: 37.76, lng: -122.45 }, {})).toMatch(/Yes|No/);
  });

  it('answers the added subjects in hider mode', () => {
    const hider = { lat: 37.76, lng: -122.45 };
    expect(hiderAnswer({ ...base('measuring'), category: 'sea-level' }, hider, {})).toMatch(/Closer|Farther/);
    expect(hiderAnswer({ ...base('measuring'), category: 'body-of-water' }, hider, {})).toMatch(/Closer|Farther/);
    expect(hiderAnswer({ ...base('matching-region'), category: 'street-path' }, hider, {})).toMatch(/Yes|No/);
    expect(hiderAnswer({ ...base('matching-region'), category: 'supervisor-district' }, hider, {})).toMatch(/Yes|No/);
  });
});

describe('hider path tracing', () => {
  const points = [
    { lat: 37.77, lng: -122.44 },
    { lat: 37.771, lng: -122.44 },
    { lat: 37.771, lng: -122.439 },
  ];
  it('measures the full multi-segment path', () => {
    expect(pathDistanceMiles(points)).toBeGreaterThan(0.1);
    expect(pathDistanceMiles(points)).toBeLessThan(0.2);
    expect(pathDistanceMiles(points.slice(0, 1))).toBe(0);
  });
  it('creates a line only after two trace points', () => {
    expect(pathGeoJson(points.slice(0, 1))).toBeUndefined();
    expect(pathGeoJson(points)?.geometry.coordinates).toHaveLength(3);
  });
});

it('administrative partitions cover every valid hiding station', () => {
  expect(supervisorDistricts.features).toHaveLength(11);
  expect(validStations.every((station) => districtAt(station))).toBe(true);
  expect(validStations.every((station) => zipCodeAt(station))).toBe(true);
  expect(validStations.every((station) => landmassAt(station))).toBe(true);
});

it('models named and not-within-reach tentacle answers', () => {
  const museum = pois.find((poi) => poi.category === 'museum')!;
  const regions = partition('museum');
  const named = constraintArea(
    { ...base('tentacle'), origin: museum, regionId: museum.id, distanceMiles: 1, answer: 'yes' },
    regions,
  );
  const outside = constraintArea(
    { ...base('tentacle'), origin: museum, regionId: museum.id, distanceMiles: 1, answer: 'not-within-reach' },
    regions,
  );
  expect(turf.area(named)).toBeGreaterThan(0);
  expect(turf.area(outside)).toBeGreaterThan(turf.area(named));
});

it('models transit-line matching and large-game metro tentacles', () => {
  const jStation = validStations.find((station) => eligibleStationIds({}, { J: 'in' }).includes(station.id))!;
  const matching = constraintArea({ ...base('matching-region'), category: 'transit-route', regionId: 'J', distanceMiles: 0.25 });
  const tentacle = constraintArea({ ...base('tentacle'), origin: jStation, category: 'transit-route', regionId: 'J', distanceMiles: 15 });
  expect(turf.area(matching)).toBeGreaterThan(0);
  expect(turf.area(tentacle)).toBeGreaterThan(0);
});

it('intersects enabled constraints and ignores disabled ones', () => {
  const first = base('radar');
  const one = turf.area(combineConstraints([first]));
  const both = turf.area(combineConstraints([first, { ...first, id: 'b', origin: { lat: 37.77, lng: -122.42 } }]));
  expect(both).toBeLessThan(one);
  expect(turf.area(combineConstraints([{ ...first, enabled: false }]))).toBeGreaterThan(one);
});

it('creates the inverse red-shading area outside the feasible polygon', () => {
  const feasible = combineConstraints([base('radar')]);
  const excluded = excludedArea(feasible);
  expect(turf.area(excluded)).toBeGreaterThan(0);
  expect(turf.area(feasible) + turf.area(excluded)).toBeCloseTo(turf.area(sfFrame()), -1);
});

it.each(PARTITION_CATEGORIES)('generates one %s region per source POI', (category) => {
  expect(Object.keys(partition(category))).toHaveLength(pois.filter((poi) => poi.category === category).length);
});

describe('transit layers and cuts', () => {
  it('contains current light-rail, Rapid Muni, and other transit routes', () => {
    expect(transitRoutes.map((route) => route.id)).toEqual(expect.arrayContaining(['F', 'J', 'K', 'L', 'M', 'N', 'T', '5R', '9R', '14R', '28R', '38R']));
    expect(primaryTransitRoutes).toHaveLength(12);
    expect(otherTransitRoutes.length).toBeGreaterThan(40);
    expect(otherTransitRoutes.map((route) => route.id)).toEqual(expect.arrayContaining(['1', '14', '38', 'CA']));
    expect(transitRouteLabel(otherTransitRoutes.find((route) => route.id === 'NBUS')!)).toBe('NBUS — other transit');
    expect(primaryTransitStationIds.length).toBeGreaterThan(0);
    expect(primaryTransitStationIds.length).toBeLessThan(validStations.length);
  });
  it('generates valid-station regions and configurable zone geometry', () => {
    expect(Object.keys(partition('game-valid-station'))).toHaveLength(193);
    expect(turf.area(stationZoneArea([validStations[0].id], 0.25))).toBeGreaterThan(0);
  });
  it('turns off stations whose hiding zones do not overlap the feasible area', () => {
    const nearby = validStations[0];
    const faraway = validStations.reduce((furthest, station) =>
      turf.distance([nearby.lng, nearby.lat], [station.lng, station.lat], { units: 'miles' }) >
      turf.distance([nearby.lng, nearby.lat], [furthest.lng, furthest.lat], { units: 'miles' }) ? station : furthest,
    );
    const feasible = turf.circle([nearby.lng, nearby.lat], 0.05, { units: 'miles' });
    const overlapping = stationIdsOverlappingArea([nearby.id, faraway.id], 0.25, feasible);
    expect(overlapping).toContain(nearby.id);
    expect(overlapping).not.toContain(faraway.id);
  });
  it('cuts explicit stations and whole routes', () => {
    const station = validStations.find((candidate) => eligibleStationIds({}, { J: 'in' }).includes(candidate.id));
    expect(station).toBeTruthy();
    expect(eligibleStationIds({ [station!.id]: 'out' }, {})).not.toContain(station!.id);
    expect(eligibleStationIds({}, { J: 'out' })).not.toContain(station!.id);
  });
});

it('calculates hider answers for rulebook question families', () => {
  const hider = { lat: 37.7705, lng: -122.4405 };
  expect(hiderAnswer({ ...base('radar'), distanceMiles: 1 }, hider, {})).toBe('Yes');
  expect(['Hotter', 'Colder']).toContain(hiderAnswer({ ...base('thermometer') }, hider, {}));
  expect(['Closer', 'Farther']).toContain(hiderAnswer({ ...base('measuring') }, hider, {}));
  expect(['Closer', 'Farther']).toContain(hiderAnswer({ ...base('coastline') }, hider, {}));
});

it('keeps all rulebook notes attached to every primary question', () => {
  for (const kind of PRIMARY_QUESTION_KINDS) {
    expect(QUESTION_DEFINITIONS[kind].notes.length).toBeGreaterThan(0);
    expect(QUESTION_DEFINITIONS[kind].sourceUrl).toMatch(/^https:\/\/www\.lifack\.ch\//);
  }
});

it('shows card-specific photo notes before general photo notes', () => {
  const cardNote = PHOTO_SUBJECTS[0].notes[0];
  expect(orderedRuleNotes('photo-reference', QUESTION_DEFINITIONS['photo-reference'].notes, [cardNote])[0]).toBe(cardNote);
  expect(orderedRuleNotes('matching-region', ['general'], ['subject'])).toEqual(['general', 'subject']);
});

it('applies bulk station and question state changes', () => {
  expect(stationStatusesForAll(['a', 'b'], 'out')).toEqual({ a: 'out', b: 'out' });
  expect(statusesForAll(['F', 'J'], 'in')).toEqual({ F: 'in', J: 'in' });
  expect(excludeAllExcept(['a', 'b', 'c'], ['b'])).toEqual({ a: 'out', c: 'out' });
  expect(stationStatusesForAll(['a', 'b'], '')).toEqual({});
  expect(setAllConstraintsEnabled([base('radar'), { ...base('measuring'), id: 'y' }], false).every((constraint) => !constraint.enabled)).toBe(true);
});

it('keeps POI partition layers mutually exclusive and allows all of them to be off', () => {
  const off = selectPoiPartition({ museum: true, library: true });
  expect(activePoiPartition(off)).toBeUndefined();
  expect(VISIBLE_POI_PARTITIONS.every((category) => off[category] === false)).toBe(true);
  const libraries = selectPoiPartition(off, 'library');
  expect(activePoiPartition(libraries)).toBe('library');
  expect(VISIBLE_POI_PARTITIONS.filter((category) => libraries[category])).toEqual(['library']);
});

const state: SharedState = {
  version: 2,
  constraints: [base('radar')],
  layers: { museum: true, 'station-zones': true },
  viewport: { center: { lat: 37.77, lng: -122.44 }, zoom: 12 },
  mode: 'seeker',
  stationZoneMiles: 0.25,
  areaDisplayMode: 'allowed-green',
  transitScope: 'all',
  stationStatuses: {},
  routeStatuses: {},
};

it('round trips versioned shared state', () => expect(decodeState(encodeState(state))).toEqual(state));
it('defaults old version 2 shares to green allowed-area shading', () => {
  const { areaDisplayMode: _areaDisplayMode, transitScope: _transitScope, ...oldState } = state;
  expect(validateState(oldState)).toMatchObject({ areaDisplayMode: 'allowed-green', transitScope: 'all' });
});
it('migrates a valid version 1 share payload', () => {
  const legacy = { version: 1, constraints: [base('radius')], layers: { museum: true }, viewport: state.viewport };
  const payload = btoa(unescape(encodeURIComponent(JSON.stringify(legacy)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  expect(decodeState(payload)).toMatchObject({ version: 2, stationZoneMiles: 0.25, areaDisplayMode: 'allowed-green', transitScope: 'all', mode: 'seeker' });
});
it('rejects malformed shared configurations', () => {
  expect(() => decodeState('garbage')).toThrow();
  expect(() => validateState({ version: 3 })).toThrow();
});
