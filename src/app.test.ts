import { describe, expect, it } from 'vitest';
import * as turf from '@turf/turf';
import { PARTITION_CATEGORIES, pois, provenance, validatePois } from './data';
import { combineConstraints, constraintArea, partition } from './geometry';
import { decodeState, encodeState, validateState } from './share';
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
  });
});

describe.each(['radius', 'thermometer', 'direction', 'closer', 'farther', 'intersection', 'exclusion'] as const)(
  '%s geometry',
  (kind) => {
    it('produces geographic area', () =>
      expect(
        turf.area(constraintArea({ ...base(kind), answer: kind === 'thermometer' ? 'colder' : 'yes' })),
      ).toBeGreaterThan(0));
  },
);

it('uses named matching regions', () => {
  const regions = partition('museum');
  const id = Object.keys(regions)[0];
  expect(turf.area(constraintArea({ ...base('matching-region'), regionId: id }, regions))).toBeGreaterThan(0);
});

it('intersects enabled constraints and ignores disabled ones', () => {
  const first = base('radius');
  const one = turf.area(combineConstraints([first]));
  const both = turf.area(
    combineConstraints([first, { ...first, id: 'b', origin: { lat: 37.77, lng: -122.42 } }]),
  );
  expect(both).toBeLessThan(one);
  expect(turf.area(combineConstraints([{ ...first, enabled: false }]))).toBeGreaterThan(one);
});

it.each(PARTITION_CATEGORIES)('generates one %s region per source POI', (category) => {
  expect(Object.keys(partition(category))).toHaveLength(pois.filter((poi) => poi.category === category).length);
});

const state: SharedState = {
  version: 1,
  constraints: [base('radius')],
  layers: { museum: true },
  viewport: { center: { lat: 37.77, lng: -122.44 }, zoom: 12 },
};

it('round trips shared state', () => expect(decodeState(encodeState(state))).toEqual(state));
it('rejects malformed shared configurations', () => {
  expect(() => decodeState('garbage')).toThrow();
  expect(() => validateState({ version: 2 })).toThrow();
});
