import * as turf from '@turf/turf';
import type { Feature, Polygon } from 'geojson';
import type { Area, Constraint, Position } from './types';
import { pois, SF_BOUNDS, SF_CENTER, type PoiCategory } from './data';
import { coastline, distanceToRoute, nearestCoastlineDistance, routesForStation, transitRoutes, validStations } from './transit';

const frame = () =>
  turf.bboxPolygon([SF_BOUNDS.west, SF_BOUNDS.south, SF_BOUNDS.east, SF_BOUNDS.north]) as Area;
const point = (position: Position) => turf.point([position.lng, position.lat]);
const empty = (): Area => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } });
const invert = (area: Area) => (turf.difference(turf.featureCollection([frame(), area])) as Area | null) ?? empty();
const clipToFrame = (area: Area) =>
  (turf.intersect(turf.featureCollection([frame(), area])) as Area | null) ?? empty();

export function nearestPoi(category: string, position: Position) {
  const candidates = pois.filter((poi) => poi.category === category);
  if (candidates.length === 0) return undefined;
  return candidates.reduce((nearest, candidate) =>
    turf.distance(point(position), point(candidate), { units: 'miles' }) <
    turf.distance(point(position), point(nearest), { units: 'miles' })
      ? candidate
      : nearest,
  );
}

function unionAreas(areas: Area[]) {
  if (areas.length === 0) return empty();
  if (areas.length === 1) return areas[0];
  return turf.union(turf.featureCollection(areas)) as Area;
}

function categoryDistanceArea(category: string, origin: Position) {
  const source = nearestPoi(category, origin);
  if (!source) return empty();
  const threshold = turf.distance(point(origin), point(source), { units: 'miles' });
  const circles = pois
    .filter((poi) => poi.category === category)
    .map((poi) => turf.circle(point(poi), threshold, { units: 'miles', steps: 32 }) as Area);
  return clipToFrame(unionAreas(circles));
}

function clipRectangleToBisector(start: Position, end: Position, hotter: boolean): Area {
  const cosine = Math.cos((SF_CENTER.lat * Math.PI) / 180);
  const score = ([lng, lat]: number[]) => {
    const x = lng * cosine;
    const sx = start.lng * cosine;
    const ex = end.lng * cosine;
    const endDelta = (x - ex) ** 2 + (lat - end.lat) ** 2;
    const startDelta = (x - sx) ** 2 + (lat - start.lat) ** 2;
    const value = endDelta - startDelta;
    return hotter ? value : -value;
  };
  let coordinates: number[][] = [
    [SF_BOUNDS.west, SF_BOUNDS.south],
    [SF_BOUNDS.east, SF_BOUNDS.south],
    [SF_BOUNDS.east, SF_BOUNDS.north],
    [SF_BOUNDS.west, SF_BOUNDS.north],
  ];
  const output: number[][] = [];
  for (let index = 0; index < coordinates.length; index += 1) {
    const a = coordinates[index];
    const b = coordinates[(index + 1) % coordinates.length];
    const aScore = score(a);
    const bScore = score(b);
    const aInside = aScore <= 0;
    const bInside = bScore <= 0;
    if (aInside) output.push(a);
    if (aInside !== bInside) {
      const fraction = aScore / (aScore - bScore);
      output.push([a[0] + fraction * (b[0] - a[0]), a[1] + fraction * (b[1] - a[1])]);
    }
  }
  coordinates = output;
  if (coordinates.length < 3) return empty();
  coordinates.push(coordinates[0]);
  return turf.polygon([coordinates]) as Area;
}

function tentacleArea(constraint: Constraint, regions: Record<string, Area>) {
  const category = constraint.category ?? 'museum';
  const reach = constraint.distanceMiles ?? 1;
  if (category === 'transit-route') {
    const eligibleRoutes = transitRoutes.filter((route) => distanceToRoute(constraint.origin, route) <= reach);
    const routeAreas = eligibleRoutes.map((route) =>
      unionAreas(route.features.map((feature) => turf.buffer(feature, reach, { units: 'miles', steps: 24 }) as Area)),
    );
    const reachable = clipToFrame(unionAreas(routeAreas));
    if (constraint.answer === 'not-within-reach' || constraint.answer === 'no') return invert(reachable);
    const selectedIndex = eligibleRoutes.findIndex((route) => route.id === constraint.regionId);
    return selectedIndex >= 0 ? clipToFrame(routeAreas[selectedIndex]) : empty();
  }
  const eligibleSources = pois.filter(
    (poi) =>
      poi.category === category &&
      turf.distance(point(constraint.origin), point(poi), { units: 'miles' }) <= reach,
  );
  const reachable = unionAreas(
    eligibleSources.map((poi) => turf.circle(point(poi), reach, { units: 'miles', steps: 32 }) as Area),
  );
  if (constraint.answer === 'not-within-reach' || constraint.answer === 'no') return invert(reachable);
  const selected = constraint.regionId ? pois.find((poi) => poi.id === constraint.regionId) : undefined;
  if (!selected || !eligibleSources.some((poi) => poi.id === selected.id)) return empty();
  const region = regions[selected.id];
  if (!region) return empty();
  return (
    (turf.intersect(
      turf.featureCollection([
        region,
        turf.circle(point(selected), reach, { units: 'miles', steps: 32 }) as Area,
      ]),
    ) as Area | null) ?? empty()
  );
}

export function constraintArea(constraint: Constraint, regions: Record<string, Area> = {}): Area {
  if (constraint.kind === 'photo-reference') return frame();
  if (constraint.kind === 'thermometer') {
    return clipRectangleToBisector(
      constraint.origin,
      constraint.target ?? constraint.origin,
      constraint.answer === 'warmer',
    );
  }
  if (constraint.kind === 'measuring') {
    const closerArea = categoryDistanceArea(constraint.category ?? 'rail-station', constraint.origin);
    return constraint.answer === 'farther' ? invert(closerArea) : closerArea;
  }
  if (constraint.kind === 'coastline') {
    const threshold = nearestCoastlineDistance(SF_CENTER);
    const closerArea = clipToFrame(
      turf.buffer(coastline, threshold, { units: 'miles', steps: 24 }) as Area,
    );
    return constraint.answer === 'farther' ? invert(closerArea) : closerArea;
  }
  if (constraint.kind === 'tentacle') return tentacleArea(constraint, regions);
  if (constraint.kind === 'matching-region') {
    if (constraint.category === 'transit-route') {
      const stationIds = validStations
        .filter((station) => routesForStation(station.id).includes(constraint.regionId ?? ''))
        .map((station) => station.id);
      const routeStations = stationZoneArea(stationIds, constraint.distanceMiles ?? 0.25);
      return constraint.answer === 'no' ? invert(routeStations) : routeStations;
    }
    const regionId = constraint.regionId ?? nearestPoi(constraint.category ?? 'museum', constraint.origin)?.id;
    const region = regions[regionId ?? ''];
    if (!region) throw new Error('Unknown matching region');
    return constraint.answer === 'no' ? invert(region) : region;
  }
  if (constraint.kind === 'direction') {
    const origin = constraint.origin;
    const direction = constraint.direction ?? 'north';
    const box: [number, number, number, number] =
      direction === 'north'
        ? [SF_BOUNDS.west, origin.lat, SF_BOUNDS.east, SF_BOUNDS.north]
        : direction === 'south'
          ? [SF_BOUNDS.west, SF_BOUNDS.south, SF_BOUNDS.east, origin.lat]
          : direction === 'east'
            ? [origin.lng, SF_BOUNDS.south, SF_BOUNDS.east, SF_BOUNDS.north]
            : [SF_BOUNDS.west, SF_BOUNDS.south, origin.lng, SF_BOUNDS.north];
    return turf.bboxPolygon(box) as Area;
  }
  const radius = constraint.distanceMiles ?? 1;
  const center = constraint.kind === 'closer' || constraint.kind === 'farther' ? constraint.target ?? constraint.origin : constraint.origin;
  const circle = turf.circle(point(center), radius, { units: 'miles', steps: 64 }) as Area;
  return constraint.kind === 'farther' || constraint.kind === 'exclusion' || constraint.answer === 'no'
    ? invert(circle)
    : circle;
}

export function combineConstraints(
  constraints: Constraint[],
  regions: Record<string, Area> = {},
  stationArea?: Area,
): Area {
  let result = stationArea ? clipToFrame(stationArea) : frame();
  for (const constraint of constraints.filter((candidate) => candidate.enabled && candidate.kind !== 'photo-reference')) {
    const next = turf.intersect(turf.featureCollection([result, constraintArea(constraint, regions)]));
    if (!next) return empty();
    result = next as Area;
  }
  return result;
}

export function partition(category: PoiCategory) {
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

export function stationZoneArea(stationIds: string[], radiusMiles: number) {
  const selected = validStations.filter((station) => stationIds.includes(station.id));
  return unionAreas(
    selected.map((station) => turf.circle(point(station), radiusMiles, { units: 'miles', steps: 24 }) as Area),
  );
}

export function positionInArea(position: Position, area: Area) {
  return turf.booleanPointInPolygon(point(position), area as Feature<Polygon>);
}

export { frame as sfFrame };
