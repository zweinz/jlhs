import * as turf from '@turf/turf';
import type { Feature, Polygon } from 'geojson';
import type { Area, Constraint, Position } from './types';
import { pois, SF_BOUNDS, SF_CENTER, type PoiCategory } from './data';
import { coastline, distanceToRoute, nearestCoastlineDistance, primaryTransitRoutes, validStations } from './transit';
import {
  districtAt,
  elevationComparisonArea,
  landmassAt,
  nearestStreet,
  normalizedStationNameLength,
  streetArea,
  waterDistanceArea,
  zipCodeAt,
} from './rulebookGeometry';

const frame = () =>
  turf.bboxPolygon([SF_BOUNDS.west, SF_BOUNDS.south, SF_BOUNDS.east, SF_BOUNDS.north]) as Area;
const point = (position: Position) => turf.point([position.lng, position.lat]);
const empty = (): Area => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } });
export const excludedArea = (area: Area) => (turf.difference(turf.featureCollection([frame(), area])) as Area | null) ?? empty();
const invert = excludedArea;
const clipToFrame = (area: Area) =>
  (turf.intersect(turf.featureCollection([frame(), area])) as Area | null) ?? empty();
const DISTANCE_CIRCLE_STEPS = 128;
const DISTANCE_SAFETY_MILES = 0.001;

function distanceCircle(position: Position, radiusMiles: number, keepInside: boolean) {
  const safeRadius = keepInside
    ? radiusMiles + DISTANCE_SAFETY_MILES
    : Math.max(0, radiusMiles - DISTANCE_SAFETY_MILES);
  return safeRadius === 0
    ? empty()
    : turf.circle(point(position), safeRadius, { units: 'miles', steps: DISTANCE_CIRCLE_STEPS }) as Area;
}

export function partitionLabelPosition(area: Area): Position {
  const [lng, lat] = turf.pointOnFeature(area).geometry.coordinates;
  return { lat, lng };
}

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

function categoryDistanceArea(category: string, origin: Position, keepInside: boolean) {
  const source = nearestPoi(category, origin);
  if (!source) return empty();
  const threshold = turf.distance(point(origin), point(source), { units: 'miles' });
  if (threshold === 0) return empty();
  const circles = pois
    .filter((poi) => poi.category === category)
    .map((poi) => distanceCircle(poi, threshold, keepInside));
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

function tentacleArea(constraint: Constraint) {
  const category = constraint.category ?? 'museum';
  const reach = constraint.distanceMiles ?? 1;
  if (category === 'transit-route') {
    const eligibleRoutes = primaryTransitRoutes.filter((route) => distanceToRoute(constraint.origin, route) <= reach);
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
    eligibleSources.map((poi) => distanceCircle(poi, reach, false)),
  );
  if (constraint.answer === 'not-within-reach' || constraint.answer === 'no') return invert(reachable);
  const selected = constraint.regionId ? pois.find((poi) => poi.id === constraint.regionId) : undefined;
  if (!selected || !eligibleSources.some((poi) => poi.id === selected.id)) return empty();
  let selectedArea = distanceCircle(selected, reach, true);
  for (const competitor of eligibleSources) {
    if (competitor.id === selected.id) continue;
    const nearerSelected = clipRectangleToBisector(competitor, selected, true);
    const intersection = turf.intersect(turf.featureCollection([selectedArea, nearerSelected]));
    if (!intersection) return empty();
    selectedArea = intersection as Area;
  }
  return clipToFrame(selectedArea);
}

export function constraintArea(constraint: Constraint, regions: Record<string, Area> = {}): Area {
  if (constraint.kind === 'photo-reference' || constraint.kind === 'endgame-confirmation' || constraint.answer === 'null') return frame();
  if (constraint.kind === 'thermometer') {
    return clipRectangleToBisector(
      constraint.origin,
      constraint.target ?? constraint.origin,
      constraint.answer === 'warmer',
    );
  }
  if (constraint.kind === 'measuring') {
    const category = constraint.category ?? 'rail-station';
    const keepInside = constraint.answer !== 'farther';
    const closerArea = category === 'sea-level'
      ? elevationComparisonArea(constraint.origin)
      : category === 'body-of-water'
        ? waterDistanceArea(constraint.origin)
        : category === 'coastline'
          ? clipToFrame(turf.buffer(coastline, nearestCoastlineDistance(constraint.origin), { units: 'miles', steps: 24 }) as Area)
          : categoryDistanceArea(category, constraint.origin, keepInside);
    return constraint.answer === 'farther' ? invert(closerArea) : closerArea;
  }
  if (constraint.kind === 'coastline') {
    const threshold = nearestCoastlineDistance(constraint.origin);
    const closerArea = clipToFrame(
      turf.buffer(coastline, threshold, { units: 'miles', steps: 24 }) as Area,
    );
    return constraint.answer === 'farther' ? invert(closerArea) : closerArea;
  }
  if (constraint.kind === 'tentacle') return tentacleArea(constraint);
  if (constraint.kind === 'matching-region') {
    const matchingAnswer = (area: Area) => constraint.answer === 'no' ? invert(area) : area;
    if (constraint.category === 'transit-route') {
      // Transit-line matching is a property of the chosen hiding station, not a distance polygon.
      // The station list is filtered separately so nearby stations do not bleed into each other.
      return frame();
    }
    if (constraint.category === 'station-name-length') {
      const source = nearestPoi('game-valid-station', constraint.origin);
      if (!source) return empty();
      const sourceLength = normalizedStationNameLength(source.name);
      return matchingAnswer(unionAreas(
        validStations
          .filter((station) => normalizedStationNameLength(station.name) === sourceLength)
          .map((station) => regions[station.id])
          .filter((area): area is Area => Boolean(area)),
      ));
    }
    if (constraint.category === 'street-path') return matchingAnswer(streetArea(nearestStreet(constraint.origin)));
    if (constraint.category === 'supervisor-district') {
      const district = districtAt(constraint.origin);
      return district ? matchingAnswer(district as Area) : empty();
    }
    if (constraint.category === 'landmass') {
      const landmass = landmassAt(constraint.origin);
      return landmass ? matchingAnswer(landmass as Area) : empty();
    }
    if (constraint.category === 'zip-code') {
      const zipCode = zipCodeAt(constraint.origin);
      return zipCode ? matchingAnswer(zipCode as Area) : empty();
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
  const outsideAnswer = constraint.kind === 'farther' || constraint.kind === 'exclusion' || constraint.answer === 'no';
  const circle = distanceCircle(center, radius, !outsideAnswer);
  return outsideAnswer
    ? invert(circle)
    : circle;
}

export function combineConstraints(
  constraints: Constraint[],
  regions: Record<string, Area> = {},
  stationArea?: Area,
): Area {
  let result = stationArea ? clipToFrame(stationArea) : frame();
  for (const constraint of constraints.filter((candidate) => candidate.enabled &&
    candidate.kind !== 'photo-reference' && candidate.kind !== 'endgame-confirmation')) {
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

export function stationIdsOverlappingArea(stationIds: string[], radiusMiles: number, area: Area) {
  if (area.geometry.coordinates.length === 0) return [];
  const selected = new Set(stationIds);
  return validStations
    .filter((station) => selected.has(station.id))
    .filter((station) => turf.booleanIntersects(
      turf.circle(point(station), radiusMiles, { units: 'miles', steps: 24 }),
      area,
    ))
    .map((station) => station.id);
}

export function positionInArea(position: Position, area: Area) {
  return turf.booleanPointInPolygon(point(position), area as Feature<Polygon>);
}

export { frame as sfFrame };
