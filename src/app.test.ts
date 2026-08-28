import { describe, expect, it } from 'vitest';
import * as turf from '@turf/turf';
import { excludeAllExcept, setAllConstraintsEnabled, stationStatusesForAll, statusesForAll } from './bulkActions';
import { PARTITION_CATEGORIES, pois, provenance, validatePois } from './data';
import { activeMapPartition, activePoiPartition, selectMapPartition, selectPoiPartition, VISIBLE_POI_PARTITIONS } from './layers';
import { persistManualReachBoundary, restoreManualReachBoundary } from './manualReachStorage';
import { combineConstraints, constraintArea, excludedArea, manualReachArea, nearestPoi, partition, partitionLabelPosition, positionInArea, questionPreviewArea, sfFrame, stationIdsOverlappingArea, stationZoneArea } from './geometry';
import { hiderAnswer, solveHiderQuestion } from './hider';
import { formatMeasuredDistanceMiles, formatQuestionDistance, missingQuestionFields, orderedRuleNotes, PRIMARY_QUESTION_KINDS, QUESTION_DEFINITIONS, questionIsReady, RULEBOOK_DISTANCE_CHOICES, thermometerPinDistanceMiles } from './questions';
import { MATCHING_SUBJECTS, MEASURING_SUBJECTS, PHOTO_SUBJECTS, SF_MATCHING_SUBJECTS, selectableSubjects } from './rulebook';
import { districtAt, elevationAt, landmassAt, nearestStreet, nearestStreetOrientation, nearestWaterDistance, supervisorDistricts, zipCodeAreas, zipCodeAt } from './rulebookGeometry';
import { pathDistanceMiles, pathGeoJson } from './trace';
import { decodeState, encodeState, validateState } from './share';
import { allowedHidingArea, bufferedNoHideZones, isHidingPositionAllowed, noHideZoneProvenance } from './noHideZones';
import { eligibleStationIds, filterStationsBySearch, otherTransitRoutes, primaryTransitRoutes, primaryTransitStationIds, routesForStation, shouldDisplayStationZone, stationIdsMatchingTransitQuestions, stationRouteProvenance, transitRouteLabel, transitRoutes, validStations } from './transit';
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

  it('filters stations by every search term while preserving source order', () => {
    expect(filterStationsBySearch(validStations, '')).toBe(validStations);
    expect(filterStationsBySearch(validStations, 'mission').map((station) => station.name)).toEqual([
      '16th St Mission',
      '24th St Mission',
      '3rd St & Mission Rock St',
      'Mission St & 20th St',
      'Mission St & Murray St',
      'Mission St & Silver Ave',
      'Geneva Ave & Mission St',
      'Mission St & Lowell St',
    ]);
    expect(filterStationsBySearch(validStations, 'mission 24').map((station) => station.name)).toEqual([
      '24th St Mission',
    ]);
    expect(filterStationsBySearch(validStations, 'not a station')).toEqual([]);
  });
});

describe('No-hide zones', () => {
  it('loads three buffered document-derived regions and excludes their representative points', () => {
    expect(bufferedNoHideZones.features).toHaveLength(3);
    expect(noHideZoneProvenance).toMatchObject({ bufferFeet: 300, reviewed: '2026-08-25' });
    expect(isHidingPositionAllowed({ lat: 37.784, lng: -122.415 })).toBe(false);
    expect(isHidingPositionAllowed({ lat: 37.776, lng: -122.408 })).toBe(false);
    expect(isHidingPositionAllowed({ lat: 37.74, lng: -122.39 })).toBe(false);
    expect(isHidingPositionAllowed({ lat: 37.76, lng: -122.49 })).toBe(true);
  });

  it('keeps every no-hide label and boundary description available to the map layer', () => {
    expect(bufferedNoHideZones.features.every((feature) =>
      feature.properties.id && feature.properties.name && feature.properties.boundary)).toBe(true);
  });

  it('removes no-hide points from the common allowed hiding area', () => {
    expect(turf.booleanPointInPolygon([-122.415, 37.784], allowedHidingArea)).toBe(false);
    expect(turf.booleanPointInPolygon([-122.49, 37.76], allowedHidingArea)).toBe(true);
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
  it('keeps new location-dependent questions incomplete until every required pin is set', () => {
    const radar = { ...base('radar'), originSet: false, enabled: false };
    expect(missingQuestionFields(radar)).toEqual(['seeker pin']);
    expect(questionIsReady(radar)).toBe(false);
    expect(questionIsReady({ ...radar, originSet: true })).toBe(true);

    const thermometer = { ...base('thermometer'), originSet: false, targetSet: false, enabled: false };
    expect(missingQuestionFields(thermometer)).toEqual(['starting pin', 'ending pin']);
    expect(questionIsReady({ ...thermometer, originSet: true, targetSet: true })).toBe(true);

    const transitMatch = { ...base('matching-region'), category: 'transit-route', regionId: 'N', originSet: false };
    expect(questionIsReady(transitMatch)).toBe(true);

    const endGame = { ...base('endgame-confirmation'), originSet: false, answerSet: false, enabled: false };
    expect(missingQuestionFields(endGame)).toEqual(['end-zone pin', 'hider result']);
    expect(questionIsReady({ ...endGame, originSet: true, answerSet: true })).toBe(true);
    expect(turf.area(combineConstraints([{ ...endGame, originSet: true, answerSet: true, enabled: true }]))).toBeCloseTo(turf.area(sfFrame()));
  });

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
    expect(PHOTO_SUBJECTS).toHaveLength(14);
    expect([...MATCHING_SUBJECTS, ...MEASURING_SUBJECTS, ...PHOTO_SUBJECTS].some((subject) => /homebrew/i.test(subject.label))).toBe(false);
    expect(MATCHING_SUBJECTS.find((subject) => subject.id === 'aquarium')?.status).toBe('out-of-play');
    expect(MEASURING_SUBJECTS.find((subject) => subject.id === 'aquarium')?.status).toBe('in-play');
    expect(selectableSubjects(MEASURING_SUBJECTS).some((subject) => subject.id === 'sea-level')).toBe(true);
    expect(SF_MATCHING_SUBJECTS).toContainEqual(expect.objectContaining({
      id: 'zip-code', label: 'ZIP-code area', status: 'in-play', support: 'exact',
    }));
    expect(SF_MATCHING_SUBJECTS.find((subject) => subject.id === 'zip-code')?.notes.join(' ')).toMatch(/not official administrative divisions/i);
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

  it('offers the printed small-game distance cards plus custom entry', () => {
    expect(RULEBOOK_DISTANCE_CHOICES.radar).toEqual([0.25, 0.5, 1, 3, 5, 10, 25, 50, 100]);
    expect(RULEBOOK_DISTANCE_CHOICES.thermometer).toEqual([0.5, 3]);
    expect(formatQuestionDistance(0.25)).toBe('¼ mile');
    expect(formatQuestionDistance(0.5)).toBe('½ mile');
  });

  it('calculates and formats thermometer travel distance only after both pins are set', () => {
    const thermometer = {
      ...base('thermometer'),
      originSet: true,
      targetSet: true,
      origin: { lat: 37.7749, lng: -122.4194 },
      target: { lat: 37.7849, lng: -122.4194 },
    };
    const distanceMiles = thermometerPinDistanceMiles(thermometer);
    expect(distanceMiles).toBeGreaterThan(0.68);
    expect(distanceMiles).toBeLessThan(0.70);
    expect(formatMeasuredDistanceMiles(distanceMiles!)).toBe('0.69 miles');
    expect(thermometerPinDistanceMiles({ ...thermometer, targetSet: false })).toBeUndefined();
    expect(questionIsReady({ ...thermometer, distanceMiles: 3 })).toBe(true);
  });

  it('does not expose hider-side matching values in AI or helper responses', () => {
    const hider = { lat: 37.73, lng: -122.42 };
    for (const subject of selectableSubjects(MATCHING_SUBJECTS)) {
      const result = solveHiderQuestion({
        ...base('matching-region'),
        category: subject.id,
        regionId: subject.id === 'transit-route' ? 'N' : undefined,
      }, hider);
      expect(result.displayText, subject.label).toMatch(/^(Yes|No|Null)$/);
      expect(result.resolvedRegionId, subject.label).toBeUndefined();
    }
  });

  it('limits each non-photo response family to its rulebook answer', () => {
    const hider = { lat: 37.77, lng: -122.44 };
    expect(solveHiderQuestion(base('radar'), hider).displayText).toMatch(/^(Yes|No)$/);
    expect(solveHiderQuestion(base('thermometer'), hider).displayText).toMatch(/^(Hotter|Colder)$/);
    expect(solveHiderQuestion(base('measuring'), hider).displayText).toMatch(/^(Closer|Further|Null)$/);

    const tentacle = solveHiderQuestion({ ...base('tentacle'), origin: hider }, hider);
    expect(tentacle.answer).toBe('yes');
    expect(tentacle.resolvedRegionId).toBeTruthy();
    expect(tentacle.displayText).not.toMatch(/^(Yes|No)$/);
  });

  it('treats a null answer as a completed question without changing map shading', () => {
    const nullArea = constraintArea({ ...base('matching-region'), answer: 'null' });
    const referenceArea = constraintArea(base('photo-reference'));
    expect(turf.area(nullArea)).toBeCloseTo(turf.area(referenceArea));
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
    const orientation = nearestStreetOrientation(base('radar').origin)!;
    expect(orientation.name).toBe(nearestStreet(base('radar').origin));
    expect(orientation.bearing).toBeGreaterThanOrEqual(0);
    expect(orientation.bearing).toBeLessThan(180);
    expect(districtAt(base('radar').origin)?.properties.name).toMatch(/District/);
    expect(landmassAt(base('radar').origin)?.properties.name).toBeTruthy();
  });

  it('reads the south-to-north street grid without mirroring Jefferson and Taylor', () => {
    const jeffersonAndTaylor = { lat: 37.80832, lng: -122.415514 };
    expect(nearestStreet(jeffersonAndTaylor)).toBe('JEFFERSON ST');
    expect(nearestStreetOrientation(jeffersonAndTaylor)).toEqual({ name: 'JEFFERSON ST', bearing: 81 });
    expect(elevationAt({ lat: 37.7544, lng: -122.4477 })).toBeGreaterThan(700);
    expect(elevationAt({ lat: 37.7955, lng: -122.3937 })).toBeLessThan(50);
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
    expect(hiderAnswer({ ...base('measuring'), category: 'sea-level' }, hider, {})).toMatch(/Closer|Further/);
    expect(hiderAnswer({ ...base('measuring'), category: 'body-of-water' }, hider, {})).toMatch(/Closer|Further/);
    expect(hiderAnswer({ ...base('matching-region'), category: 'street-path' }, hider, {})).toMatch(/Yes|No/);
    expect(hiderAnswer({ ...base('matching-region'), category: 'supervisor-district' }, hider, {})).toMatch(/Yes|No/);
  });

  it('handles a zero-distance category measurement without invalid geometry', () => {
    const railStation = pois.find((poi) => poi.category === 'rail-station')!;
    const closer = constraintArea({
      ...base('measuring'), origin: railStation, category: 'rail-station', answer: 'closer',
    });
    const farther = constraintArea({
      ...base('measuring'), origin: railStation, category: 'rail-station', answer: 'farther',
    });
    expect(turf.area(closer)).toBe(0);
    expect(turf.area(farther)).toBeCloseTo(turf.area(sfFrame()), -1);
  });

  it('returns null when an administrative pin has no mapped region', () => {
    const outsideDistricts = { lat: 37.705, lng: -122.525 };
    expect(districtAt(outsideDistricts)).toBeUndefined();
    expect(solveHiderQuestion({
      ...base('matching-region'), origin: outsideDistricts, category: 'supervisor-district',
    }, outsideDistricts)).toMatchObject({ answer: 'null', displayText: 'Null' });
  });

  it('keeps equal elevation in the farther answer area', () => {
    const position = validStations[0];
    const result = solveHiderQuestion({
      ...base('measuring'), origin: position, category: 'sea-level',
    }, position);
    expect(result.answer).toBe('farther');
    const area = constraintArea({
      ...base('measuring'), origin: position, category: 'sea-level', answer: result.answer!,
    });
    expect(turf.booleanPointInPolygon([position.lng, position.lat], area)).toBe(true);
  });

  it('keeps truthful points just inside circular question boundaries', () => {
    const origin = { lat: 37.77, lng: -122.44 };
    const destination = turf.destination([origin.lng, origin.lat], 0.9999, 1.40625, { units: 'miles' });
    const hider = { lat: destination.geometry.coordinates[1], lng: destination.geometry.coordinates[0] };
    const radar = { ...base('radar'), origin, distanceMiles: 1 };
    const radarResult = solveHiderQuestion(radar, hider);
    expect(radarResult.answer).toBe('yes');
    expect(turf.booleanPointInPolygon(
      [hider.lng, hider.lat], constraintArea({ ...radar, answer: radarResult.answer! }),
    )).toBe(true);

    const hospital = pois.find((poi) => poi.category === 'hospital' && poi.name === 'CPMC Pacific Heights')!;
    const nearLimitHider = { lat: 37.8051830029014, lng: -122.432185393785 };
    const tentacle = {
      ...base('tentacle'), origin: hospital, category: 'hospital', distanceMiles: 1,
    };
    const tentacleResult = solveHiderQuestion(tentacle, nearLimitHider);
    expect(tentacleResult).toMatchObject({ answer: 'yes', resolvedRegionId: hospital.id });
    expect(turf.booleanPointInPolygon(
      [nearLimitHider.lng, nearLimitHider.lat],
      constraintArea({ ...tentacle, answer: tentacleResult.answer!, regionId: tentacleResult.resolvedRegionId }),
    )).toBe(true);
  });
});

it('places partition pins inside every Supervisorial district and ZIP area', () => {
  for (const feature of [...supervisorDistricts.features, ...zipCodeAreas.features]) {
    const position = partitionLabelPosition(feature);
    expect(turf.booleanPointInPolygon([position.lng, position.lat], feature)).toBe(true);
  }
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

it('partitions named tentacles against only seeker-reachable sources', () => {
  const main = pois.find((poi) => poi.category === 'library' && poi.name === 'Main Branch')!;
  const eureka = pois.find((poi) => poi.category === 'library' && poi.name === 'Eureka Valley')!;
  const hider = { lat: 37.76799099984212, lng: -122.4244987392229 };
  const constraint = {
    ...base('tentacle'), origin: main, category: 'library', regionId: main.id,
    distanceMiles: 1, answer: 'yes' as const,
  };
  expect(turf.distance([main.lng, main.lat], [eureka.lng, eureka.lat], { units: 'miles' })).toBeGreaterThan(1);
  expect(turf.distance([hider.lng, hider.lat], [eureka.lng, eureka.lat], { units: 'miles' }))
    .toBeLessThan(turf.distance([hider.lng, hider.lat], [main.lng, main.lat], { units: 'miles' }));
  expect(solveHiderQuestion(constraint, hider).resolvedRegionId).toBe(main.id);
  expect(turf.booleanPointInPolygon([hider.lng, hider.lat], constraintArea(constraint, partition('library')))).toBe(true);
});

it('states the reachable-source Tentacle rule explicitly', () => {
  expect(QUESTION_DEFINITIONS.tentacle.notes.join(' ')).toMatch(/only category items within the stated distance of the seeker/i);
  expect(QUESTION_DEFINITIONS.tentacle.notes.join(' ')).toMatch(/out-of-reach item does not compete/i);
});

it('keeps transit-line matching station-based and models transit tentacle geometry independently', () => {
  const jStation = validStations.find((station) => eligibleStationIds({}, { J: 'in' }).includes(station.id))!;
  const nearMatching = constraintArea({ ...base('matching-region'), category: 'transit-route', regionId: 'J', distanceMiles: 0.05 });
  const farMatching = constraintArea({ ...base('matching-region'), category: 'transit-route', regionId: 'J', distanceMiles: 5 });
  const tentacle = constraintArea({ ...base('tentacle'), origin: jStation, category: 'transit-route', regionId: 'J', distanceMiles: 15 });
  expect(turf.area(nearMatching)).toBeCloseTo(turf.area(sfFrame()), -1);
  expect(turf.area(farMatching)).toBeCloseTo(turf.area(nearMatching), -1);
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
  it('uses scheduled stops to apply transit matching answers exactly', () => {
    const rapidStop = validStations.find((station) => station.name === 'Geary Blvd & 6th Ave')!;
    const localOnlyStop = validStations.find((station) => station.name === 'V.A. Hospital')!;
    expect(routesForStation(rapidStop.id)).toEqual(expect.arrayContaining(['38', '38R']));
    expect(routesForStation(localOnlyStop.id)).toContain('38');
    expect(routesForStation(localOnlyStop.id)).not.toContain('38R');

    const oceanAndLee = validStations.find((station) => station.name === 'Ocean Ave & Lee St')!;
    expect(routesForStation(oceanAndLee.id)).toContain('29');
    const sunsetQuestion = { ...base('matching-region'), category: 'transit-route', regionId: '29' };
    expect(stationIdsMatchingTransitQuestions([oceanAndLee.id], [{ ...sunsetQuestion, answer: 'yes' }])).toEqual([oceanAndLee.id]);
    expect(stationIdsMatchingTransitQuestions([oceanAndLee.id], [{ ...sunsetQuestion, answer: 'no' }])).toEqual([]);

    const sameNamePeerServices: Record<string, string[]> = {
      'sf:game-valid-station:021': ['NBUS', 'NOWL'],
      'sf:game-valid-station:022': ['NBUS', 'NOWL'],
      'sf:game-valid-station:023': ['NBUS', 'NOWL'],
      'sf:game-valid-station:043': ['29'],
      'sf:game-valid-station:044': ['28', '28R', '91'],
      'sf:game-valid-station:045': ['28', '28R', '29', '91'],
      'sf:game-valid-station:049': ['NBUS', 'NOWL'],
      'sf:game-valid-station:056': ['N'],
      'sf:game-valid-station:066': ['91'],
      'sf:game-valid-station:075': ['1X'],
      'sf:game-valid-station:078': ['1X'],
      'sf:game-valid-station:088': ['1X'],
      'sf:game-valid-station:089': ['31'],
      'sf:game-valid-station:091': ['NOWL'],
      'sf:game-valid-station:092': ['91'],
      'sf:game-valid-station:100': ['90', '91'],
      'sf:game-valid-station:101': ['90'],
      'sf:game-valid-station:103': ['90'],
      'sf:game-valid-station:106': ['FBUS', 'LOWL'],
      'sf:game-valid-station:121': ['90'],
      'sf:game-valid-station:130': ['90'],
      'sf:game-valid-station:131': ['90'],
      'sf:game-valid-station:136': ['91'],
      'sf:game-valid-station:145': ['91'],
      'sf:game-valid-station:146': ['91'],
      'sf:game-valid-station:152': ['KBUS', 'LOWL'],
      'sf:game-valid-station:154': ['52'],
    };
    for (const [stationId, services] of Object.entries(sameNamePeerServices)) {
      expect(routesForStation(stationId)).toEqual(expect.arrayContaining(services));
    }

    const candidates = [rapidStop.id, localOnlyStop.id];
    const question = { ...base('matching-region'), category: 'transit-route', regionId: '38R' };
    expect(stationIdsMatchingTransitQuestions(candidates, [{ ...question, answer: 'yes' }])).toEqual([rapidStop.id]);
    expect(stationIdsMatchingTransitQuestions(candidates, [{ ...question, answer: 'no' }])).toEqual([localOnlyStop.id]);
    expect(stationIdsMatchingTransitQuestions(candidates, [{ ...question, answer: 'yes', enabled: false }])).toEqual(candidates);
    const intersected = stationIdsMatchingTransitQuestions(validStations.map((station) => station.id), [
      { ...question, id: 'n-yes', regionId: 'N', answer: 'yes' },
      { ...question, id: 't-no', regionId: 'T', answer: 'no' },
    ]);
    expect(intersected.length).toBeGreaterThan(0);
    expect(intersected.every((stationId) => routesForStation(stationId).includes('N') && !routesForStation(stationId).includes('T'))).toBe(true);
    expect(stationRouteProvenance.dataset).toMatch(/GTFS/);
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
  expect(['Closer', 'Further']).toContain(hiderAnswer({ ...base('measuring') }, hider, {}));
  expect(['Closer', 'Further']).toContain(hiderAnswer({ ...base('coastline') }, hider, {}));
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

it('uses one dropdown selection across geographic and POI partitions', () => {
  const districts = selectMapPartition({ museum: true, 'zip-codes': true }, 'supervisor-districts');
  expect(activeMapPartition(districts)).toBe('supervisor-districts');
  expect(districts.museum).toBe(false);
  expect(districts['zip-codes']).toBe(false);
  const hospitals = selectMapPartition(districts, 'hospital');
  expect(activeMapPartition(hospitals)).toBe('hospital');
  expect(hospitals['supervisor-districts']).toBe(false);
  expect(selectMapPartition(hospitals)).toMatchObject({ hospital: false, 'supervisor-districts': false });
});

const state: SharedState = {
  version: 2,
  constraints: [base('radar')],
  layers: { museum: true, 'station-zones': true, 'sticky-map': true },
  viewport: { center: { lat: 37.77, lng: -122.44 }, zoom: 12 },
  mode: 'seeker',
  stationZoneMiles: 0.25,
  areaDisplayMode: 'allowed-green',
  transitScope: 'all',
  stationStatuses: {},
  routeStatuses: {},
  endGameActive: false,
};

it('round trips the same active map through the stripped version-4 share format', () => {
  const encoded = encodeState(state);
  const restored = decodeState(encoded);
  expect(encodeState(restored)).toBe(encoded);
  expect(restored).toMatchObject({
    mode: 'seeker',
    viewport: state.viewport,
    stationZoneMiles: state.stationZoneMiles,
    areaDisplayMode: state.areaDisplayMode,
    transitScope: state.transitScope,
    layers: { museum: true, 'station-zones': true, 'sticky-map': true, 'partition-pins': true },
  });
  expect(restored.constraints).toHaveLength(1);
  expect(restored.constraints[0]).toMatchObject({
    id: 'shared-1', name: 'Radar', kind: 'radar', enabled: true, answer: 'yes',
    origin: state.constraints[0].origin, distanceMiles: 1,
  });
  expect(restored.constraints[0]).not.toHaveProperty('target');
  expect(restored.constraints[0]).not.toHaveProperty('category');
  expect(turf.area(constraintArea(restored.constraints[0]))).toBeCloseTo(turf.area(constraintArea(state.constraints[0])));
});
it('round trips a user-researched maximum reach boundary', () => {
  const bounded: SharedState = {
    ...state,
    manualReachBoundary: {
      enabled: true,
      visible: true,
      regions: [{
        id: 'research-1',
        points: [
          { lat: 37.78, lng: -122.48 },
          { lat: 37.78, lng: -122.42 },
          { lat: 37.73, lng: -122.45 },
        ],
      }],
    },
  };
  const encoded = encodeState(bounded);
  const restored = decodeState(encoded);
  expect(encodeState(restored)).toBe(encoded);
  expect(restored.manualReachBoundary).toMatchObject({
    enabled: true,
    visible: true,
    regions: [{ points: bounded.manualReachBoundary?.regions[0].points }],
  });
  expect(() => validateState({ ...bounded, manualReachBoundary: { ...bounded.manualReachBoundary!, regions: [{ id: 'bad', points: bounded.manualReachBoundary!.regions[0].points.slice(0, 2) }] } })).toThrow(/manual reach/i);
  const legacyMetadata = structuredClone(bounded) as unknown as { manualReachBoundary: { regions: Array<Record<string, unknown>> } };
  legacyMetadata.manualReachBoundary.regions[0].note = 'Remove me';
  legacyMetadata.manualReachBoundary.regions[0].sourceUrl = 'https://example.com';
  legacyMetadata.manualReachBoundary.regions[0].travelTimeMinutes = 60;
  expect(validateState(legacyMetadata).manualReachBoundary?.regions[0]).toEqual(bounded.manualReachBoundary?.regions[0]);
});

it('omits every non-map question field from version-4 shares', () => {
  const longMapUrl = `https://www.google.com/maps/search/?api=1&query=${'x'.repeat(900)}`;
  const mapOnly: SharedState = {
    ...state,
    mode: 'hider',
    endGameActive: true,
    hiderPosition: { lat: 37.76, lng: -122.45 },
    constraints: [
      { ...base('radar'), id: 'private-id', name: 'Custom secret label', originMapUrl: longMapUrl },
      { ...base('measuring'), id: 'disabled', enabled: false },
      { ...base('photo-reference'), id: 'photo' },
      { ...base('endgame-confirmation'), id: 'endgame' },
      { ...base('matching-region'), id: 'null', answer: 'null' },
    ],
    layers: { ...state.layers, ignoredLayer: true },
  };
  const encoded = encodeState(mapOnly);
  expect(encoded.length).toBeLessThan(1_000);
  const normalized = encoded.replaceAll('-', '+').replaceAll('_', '/');
  const wire = decodeURIComponent(escape(atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))));
  expect(JSON.parse(wire)).toMatchObject({ v: 4 });
  expect(wire).not.toContain('Custom secret label');
  expect(wire).not.toContain('google.com');
  expect(wire).not.toContain('private-id');
  const restored = decodeState(encoded);
  expect(restored.constraints.map((constraint) => constraint.kind)).toEqual(['radar']);
  expect(restored.mode).toBe('seeker');
  expect(restored.endGameActive).toBe(false);
  expect(restored.hiderPosition).toBeUndefined();
  expect(restored.layers).not.toHaveProperty('ignoredLayer');
});

it('keeps a maximum-size manual boundary below the text-message budget', () => {
  const points = Array.from({ length: 200 }, (_, index) => {
    const angle = index * 2 * Math.PI / 200;
    return { lat: 37.76 + Math.sin(angle) * 0.02, lng: -122.44 + Math.cos(angle) * 0.025 };
  });
  const encoded = encodeState({
    ...state,
    manualReachBoundary: { enabled: true, visible: true, regions: [{ id: 'large', points }] },
  });
  expect(encoded.length).toBeLessThan(3_000);
  expect(decodeState(encoded).manualReachBoundary?.regions[0].points).toHaveLength(200);
});

it('persists the latest manual boundary only for the current share URL', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const boundary: NonNullable<SharedState['manualReachBoundary']> = {
    enabled: true,
    visible: true,
    regions: [{ id: 'local', points: [
      { lat: 37.78, lng: -122.48 },
      { lat: 37.78, lng: -122.42 },
      { lat: 37.73, lng: -122.45 },
    ] }],
  };
  persistManualReachBoundary(storage, 'config-a', boundary);
  expect(restoreManualReachBoundary(storage, 'config-a')).toEqual({ matched: true, boundary });
  expect(restoreManualReachBoundary(storage, 'config-b')).toEqual({ matched: false });
  persistManualReachBoundary(storage, 'config-a', undefined);
  expect(restoreManualReachBoundary(storage, 'config-a')).toEqual({ matched: true, boundary: undefined });
});
it('keeps a fully marked station board compact enough for messaging', () => {
  const marked = {
    ...state,
    stationStatuses: Object.fromEntries(validStations.map((station, index) => [station.id, index % 2 ? 'in' : 'out'])),
    routeStatuses: Object.fromEntries(transitRoutes.map((route, index) => [route.id, index % 2 ? 'out' : 'in'])),
  } as SharedState;
  const encoded = encodeState(marked);
  expect(encoded.length).toBeLessThan(2000);
  expect(decodeState(encoded).stationStatuses).toEqual(marked.stationStatuses);
  expect(decodeState(encoded).routeStatuses).toEqual(marked.routeStatuses);
});
it('defaults old version 2 shares to transparent allowed and red excluded shading', () => {
  const { areaDisplayMode: _areaDisplayMode, transitScope: _transitScope, ...oldState } = state;
  expect(validateState(oldState)).toMatchObject({ areaDisplayMode: 'excluded-red', transitScope: 'all', layers: { 'sticky-map': true } });
});
it('defaults the sticky map on and removes the retired coastline overlay', () => {
  expect(validateState({ ...state, layers: { coastline: true } }).layers).toEqual({ 'sticky-map': true });
});
it('migrates a valid version 1 share payload', () => {
  const legacy = { version: 1, constraints: [base('radius')], layers: { museum: true }, viewport: state.viewport };
  const payload = btoa(unescape(encodeURIComponent(JSON.stringify(legacy)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  expect(decodeState(payload)).toMatchObject({ version: 2, stationZoneMiles: 0.25, areaDisplayMode: 'excluded-red', transitScope: 'all', mode: 'seeker' });
});
it('continues to restore version-3 compact share payloads', () => {
  const emptyStatuses = (count: number) => btoa('\0'.repeat(Math.ceil(count / 4))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const wire = {
    v: 3,
    state,
    stations: emptyStatuses(validStations.length),
    routes: emptyStatuses(transitRoutes.length),
  };
  const payload = btoa(unescape(encodeURIComponent(JSON.stringify(wire)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  expect(decodeState(payload)).toMatchObject(state);
});
it('rejects malformed shared configurations', () => {
  expect(() => decodeState('garbage')).toThrow();
  expect(() => validateState({ version: 3 })).toThrow();
});

it('uses the same projected nearest-hospital rule for answers and visible partitions', () => {
  const lincolnAnd21st = { lat: 37.766, lng: -122.4795 };
  const nearest = nearestPoi('hospital', lincolnAnd21st);
  expect(nearest?.name).toBe('UCSF Medical Center Parnassus');
  expect(nearest && positionInArea(lincolnAnd21st, partition('hospital')[nearest.id])).toBe(true);
});

it('previews positive and inverse Solo branches without mutating the draft', () => {
  const draft = { ...base('radar'), answer: 'yes' as const, distanceMiles: 0.25 };
  const original = structuredClone(draft);
  const yes = questionPreviewArea(draft, 'yes');
  const no = questionPreviewArea(draft, 'no');
  expect(positionInArea(draft.origin, yes)).toBe(true);
  expect(positionInArea(draft.origin, no)).toBe(false);
  expect(draft).toEqual(original);
});

it('builds disconnected manual reach regions only from user-supplied vertices', () => {
  const area = manualReachArea([{
    id: 'west',
    points: [
      { lat: 37.79, lng: -122.50 },
      { lat: 37.79, lng: -122.46 },
      { lat: 37.75, lng: -122.48 },
    ],
  }, {
    id: 'east',
    points: [
      { lat: 37.79, lng: -122.42 },
      { lat: 37.79, lng: -122.39 },
      { lat: 37.76, lng: -122.405 },
    ],
  }]);
  expect(positionInArea({ lat: 37.78, lng: -122.48 }, area)).toBe(true);
  expect(positionInArea({ lat: 37.78, lng: -122.405 }, area)).toBe(true);
  expect(positionInArea({ lat: 37.77, lng: -122.44 }, area)).toBe(false);
});
