import * as turf from '@turf/turf';
import type { Feature, FeatureCollection, LineString, MultiLineString } from 'geojson';
import coastlineRaw from './data/coastline.json';
import stationRoutesRaw from './data/station-routes.json';
import routesRaw from './data/transit-routes.json';
import { pois, type Poi } from './data';
import type { Constraint, Eligibility, Position } from './types';

export type TransitRoute = {
  id: string;
  name: string;
  mode: 'light-rail' | 'rapid-muni' | 'other-transit';
  features: Feature<LineString | MultiLineString>[];
};

export const transitModeLabel = (mode: TransitRoute['mode']) =>
  mode === 'light-rail' ? 'light rail' : mode === 'rapid-muni' ? 'Rapid Muni' : 'other transit';

export const transitRouteLabel = (route: Pick<TransitRoute, 'name' | 'mode'>) =>
  `${route.name} — ${transitModeLabel(route.mode)}`;

type RouteProperties = { routeId: string; name: string; direction: string; mode: TransitRoute['mode'] };
const routeCollection = routesRaw as FeatureCollection<LineString | MultiLineString, RouteProperties> & {
  provenance: Record<string, string>;
};
const byId = new Map<string, TransitRoute>();
for (const feature of routeCollection.features) {
  const current = byId.get(feature.properties.routeId) ?? {
    id: feature.properties.routeId,
    name: feature.properties.name,
    mode: feature.properties.mode,
    features: [],
  };
  current.features.push(feature);
  byId.set(current.id, current);
}

export const transitRoutes = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
export const primaryTransitRoutes = transitRoutes.filter((route) => route.mode !== 'other-transit');
export const otherTransitRoutes = transitRoutes.filter((route) => route.mode === 'other-transit');
export const transitRouteGeoJson = routeCollection;
export const transitProvenance = routeCollection.provenance;
const stationRouteData = stationRoutesRaw as {
  provenance: Record<string, string>;
  stationRoutes: Record<string, string[]>;
};
export const stationRouteProvenance = stationRouteData.provenance;
export const coastline = (coastlineRaw as FeatureCollection<MultiLineString>).features[0];
export const coastlineProvenance = (coastlineRaw as unknown as { provenance: Record<string, string> }).provenance;
export const validStations = pois.filter((poi) => poi.category === 'game-valid-station');

export function filterStationsBySearch(stations: Poi[], search: string) {
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return stations;
  return stations.filter((station) => {
    const name = station.name.toLocaleLowerCase();
    return terms.every((term) => name.includes(term));
  });
}

const knownRouteIds = new Set(transitRoutes.map((route) => route.id));
const stationRoutes = new Map(validStations.map((station) => [
  station.id,
  (stationRouteData.stationRoutes[station.id] ?? []).filter((routeId) => knownRouteIds.has(routeId)),
]));

export function routesForStation(stationId: string) {
  return stationRoutes.get(stationId) ?? [];
}

export function stationIdsMatchingTransitQuestions(stationIds: string[], constraints: Constraint[]) {
  const questions = constraints.filter((constraint) =>
    constraint.enabled &&
    constraint.kind === 'matching-region' &&
    constraint.category === 'transit-route' &&
    (constraint.answer === 'yes' || constraint.answer === 'no') &&
    constraint.regionId,
  );
  if (questions.length === 0) return stationIds;
  const selected = new Set(stationIds);
  return validStations.filter((station) => {
    if (!selected.has(station.id)) return false;
    const routes = routesForStation(station.id);
    return questions.every((question) =>
      question.answer === 'yes'
        ? routes.includes(question.regionId!)
        : !routes.includes(question.regionId!),
    );
  }).map((station) => station.id);
}

const primaryRouteIds = new Set(primaryTransitRoutes.map((route) => route.id));
export const primaryTransitStationIds = validStations
  .filter((station) => routesForStation(station.id).some((routeId) => primaryRouteIds.has(routeId)))
  .map((station) => station.id);

export function stationsForRoute(routeId: string) {
  return validStations.filter((station) => routesForStation(station.id).includes(routeId));
}

export function distanceToRoute(position: Position, route: TransitRoute) {
  const source = turf.point([position.lng, position.lat]);
  return Math.min(
    ...route.features.flatMap((feature) => {
      const lines = feature.geometry.type === 'MultiLineString'
        ? feature.geometry.coordinates.map((coordinates) => turf.lineString(coordinates))
        : [feature as Feature<LineString>];
      return lines.map((line) => turf.pointToLineDistance(source, line, { units: 'miles' }));
    }),
  );
}

export function eligibleStationIds(
  stationStatuses: Record<string, Eligibility>,
  routeStatuses: Record<string, Eligibility>,
) {
  const includedStations = Object.entries(stationStatuses).filter(([, value]) => value === 'in').map(([id]) => id);
  const includedRoutes = Object.entries(routeStatuses).filter(([, value]) => value === 'in').map(([id]) => id);
  const excludedRoutes = new Set(
    Object.entries(routeStatuses).filter(([, value]) => value === 'out').map(([id]) => id),
  );
  return validStations
    .filter((station) => stationStatuses[station.id] !== 'out')
    .filter((station) => routesForStation(station.id).every((route) => !excludedRoutes.has(route)))
    .filter((station) => includedStations.length === 0 || includedStations.includes(station.id))
    .filter((station) => includedRoutes.length === 0 || routesForStation(station.id).some((route) => includedRoutes.includes(route)))
    .map((station) => station.id);
}

export function shouldDisplayStationZone(layerEnabled: boolean, eligible: boolean) {
  return layerEnabled && eligible;
}

export function nearestCoastlineDistance(position: Position) {
  const nearest = turf.nearestPointOnLine(coastline, turf.point([position.lng, position.lat]), { units: 'miles' });
  return Number(nearest.properties.dist);
}
