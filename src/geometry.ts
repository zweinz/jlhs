import * as turf from '@turf/turf';
import type { Area, Constraint } from './types';
import { pois, SF_BOUNDS, type PartitionCategory } from './data';

const frame = () =>
  turf.bboxPolygon([SF_BOUNDS.west, SF_BOUNDS.south, SF_BOUNDS.east, SF_BOUNDS.north]) as Area;
const point = (position: { lat: number; lng: number }) => turf.point([position.lng, position.lat]);
const invert = (area: Area) => turf.difference(turf.featureCollection([frame(), area])) as Area;

export function constraintArea(constraint: Constraint, regions: Record<string, Area> = {}): Area {
  let area: Area;
  if (constraint.kind === 'radius' || constraint.kind === 'intersection' || constraint.kind === 'exclusion') {
    area = turf.circle(point(constraint.origin), constraint.distanceMiles ?? 1, { units: 'miles', steps: 64 }) as Area;
  } else if (constraint.kind === 'direction') {
    const bounds = SF_BOUNDS;
    const origin = constraint.origin;
    const direction = constraint.direction ?? 'north';
    const box: [number, number, number, number] =
      direction === 'north'
        ? [bounds.west, origin.lat, bounds.east, bounds.north]
        : direction === 'south'
          ? [bounds.west, bounds.south, bounds.east, origin.lat]
          : direction === 'east'
            ? [origin.lng, bounds.south, bounds.east, bounds.north]
            : [bounds.west, bounds.south, origin.lng, bounds.north];
    area = turf.bboxPolygon(box) as Area;
  } else if (constraint.kind === 'matching-region') {
    area = regions[constraint.regionId ?? ''];
    if (!area) throw new Error('Unknown matching region');
  } else {
    const target = constraint.target ?? constraint.origin;
    const radius =
      constraint.distanceMiles ?? turf.distance(point(constraint.origin), point(target), { units: 'miles' });
    area = turf.circle(point(target), radius, { units: 'miles', steps: 64 }) as Area;
    if (constraint.kind === 'farther' || constraint.answer === 'colder') area = invert(area);
  }
  if (constraint.kind === 'exclusion' || constraint.answer === 'no') area = invert(area);
  return area;
}

export function combineConstraints(constraints: Constraint[], regions: Record<string, Area> = {}): Area {
  let result = frame();
  for (const constraint of constraints.filter((candidate) => candidate.enabled)) {
    const next = turf.intersect(turf.featureCollection([result, constraintArea(constraint, regions)]));
    if (!next) return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } };
    result = next as Area;
  }
  return result;
}

export function partition(category: PartitionCategory) {
  const selected = pois.filter((poi) => poi.category === category);
  const collection = turf.featureCollection(
    selected.map((poi) => turf.point([poi.lng, poi.lat], { id: poi.id, name: poi.name })),
  );
  const voronoi = turf.voronoi(collection, {
    bbox: [SF_BOUNDS.west, SF_BOUNDS.south, SF_BOUNDS.east, SF_BOUNDS.north],
  });
  const regions: Record<string, Area> = {};
  voronoi.features.forEach((feature, index) => {
    if (feature) regions[selected[index].id] = feature as Area;
  });
  return regions;
}

export { frame as sfFrame };
