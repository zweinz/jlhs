import * as turf from '@turf/turf';
import type { Feature, FeatureCollection, LineString, MultiLineString } from 'geojson';
import coastlineRaw from './data/coastline.json';
import routesRaw from './data/transit-routes.json';
import { pois } from './data';
import type { Eligibility, Position } from './types';

export type TransitRoute = {
  id: string;
  name: string;
  mode: 'light-rail' | 'rapid-muni' | 'other-transit';
  features: Feature<LineString | MultiLineString>[];
};

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
export const coastline = (coastlineRaw as FeatureCollection<MultiLineString>).features[0];
export const coastlineProvenance = (coastlineRaw as unknown as { provenance: Record<string, string> }).provenance;
export const validStations = pois.filter((poi) => poi.category === 'game-valid-station');

const stationRoutes = new Map<string, string[]>();
for (const station of validStations) {
  const stationPoint = turf.point([station.lng, station.lat]);
  stationRoutes.set(
    station.id,
    transitRoutes
      .filter((route) =>
        route.features.some((feature) => {
          const lines = feature.geometry.type === 'MultiLineString'
            ? feature.geometry.coordinates.map((coordinates) => turf.lineString(coordinates))
            : [feature as Feature<LineString>];
          return lines.some((line) => turf.pointToLineDistance(stationPoint, line, { units: 'miles' }) <= 0.1);
        }),
      )
      .map((route) => route.id),
  );
}

export function routesForStation(stationId: string) {
  return stationRoutes.get(stationId) ?? [];
}

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

export function nearestCoastlineDistance(position: Position) {
  const nearest = turf.nearestPointOnLine(coastline, turf.point([position.lng, position.lat]), { units: 'miles' });
  return Number(nearest.properties.dist);
}
