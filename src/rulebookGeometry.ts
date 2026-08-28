import * as turf from '@turf/turf';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import areasData from './data/rulebook-areas.json';
import elevationData from './data/sf-elevation-grid.json';
import streetData from './data/sf-street-grid.json';
import { SF_BOUNDS } from './data';
import { coastline, nearestCoastlineDistance } from './transit';
import type { Area, Position } from './types';

type NamedArea = Feature<Polygon | MultiPolygon, { id: string; name: string }>;
type NumericGrid = typeof elevationData;
type StreetGrid = typeof streetData;

export const rulebookAreaProvenance = areasData.provenance;
export const elevationProvenance = elevationData.provenance;
export const streetProvenance = streetData.provenance;
export const supervisorDistricts = areasData.districts as FeatureCollection<Polygon | MultiPolygon, NamedArea['properties']>;
export const waterBodies = areasData.waters as FeatureCollection<Polygon | MultiPolygon, NamedArea['properties'] & { type?: string }>;
export const sfLandmasses = areasData.landmasses as FeatureCollection<Polygon | MultiPolygon, NamedArea['properties']>;
export const zipCodeAreas = areasData.zipCodes as FeatureCollection<Polygon | MultiPolygon, NamedArea['properties']>;

const point = (position: Position) => turf.point([position.lng, position.lat]);
const empty = (): Area => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } });
const frame = () => turf.bboxPolygon([SF_BOUNDS.west, SF_BOUNDS.south, SF_BOUNDS.east, SF_BOUNDS.north]) as Area;
const clipToFrame = (area: Area) =>
  (turf.intersect(turf.featureCollection([frame(), area])) as Area | null) ?? empty();

function gridIndex(position: Position, grid: Pick<NumericGrid, 'bounds' | 'width' | 'height'>) {
  const x = Math.max(0, Math.min(grid.width - 1, Math.floor(((position.lng - grid.bounds.west) / (grid.bounds.east - grid.bounds.west)) * grid.width)));
  // Generated rows run south-to-north; row zero is the southern edge.
  const y = Math.max(0, Math.min(grid.height - 1, Math.floor(((position.lat - grid.bounds.south) / (grid.bounds.north - grid.bounds.south)) * grid.height)));
  return y * grid.width + x;
}

function gridArea<T>(grid: Pick<NumericGrid, 'bounds' | 'width' | 'height'>, values: T[], includes: (value: T) => boolean): Area {
  const cellWidth = (grid.bounds.east - grid.bounds.west) / grid.width;
  const cellHeight = (grid.bounds.north - grid.bounds.south) / grid.height;
  const polygons: number[][][][] = [];
  for (let y = 0; y < grid.height; y += 1) {
    let runStart = -1;
    for (let x = 0; x <= grid.width; x += 1) {
      const selected = x < grid.width && includes(values[y * grid.width + x]);
      if (selected && runStart < 0) runStart = x;
      if (!selected && runStart >= 0) {
        const west = grid.bounds.west + runStart * cellWidth;
        const east = grid.bounds.west + x * cellWidth;
        const south = grid.bounds.south + y * cellHeight;
        const north = south + cellHeight;
        polygons.push([[[west, south], [east, south], [east, north], [west, north], [west, south]]]);
        runStart = -1;
      }
    }
  }
  return polygons.length ? turf.multiPolygon(polygons) as Area : empty();
}

export function elevationAt(position: Position) {
  return elevationData.valuesFeet[gridIndex(position, elevationData)];
}

export function elevationComparisonArea(origin: Position) {
  const threshold = elevationAt(origin);
  return gridArea(elevationData, elevationData.valuesFeet, (elevation) => elevation < threshold);
}

export function nearestStreet(position: Position) {
  const nameIndex = streetData.values[gridIndex(position, streetData)];
  return streetData.names[nameIndex];
}

export function nearestStreetOrientation(position: Position) {
  const index = gridIndex(position, streetData);
  const name = streetData.names[streetData.values[index]];
  const bearing = streetData.bearings[index];
  if (name === 'Unknown' || bearing === null) return undefined;
  return {
    name,
    bearing,
  };
}

export function streetArea(name: string) {
  const nameIndex = streetData.names.indexOf(name);
  if (nameIndex < 0) return empty();
  return gridArea(streetData, streetData.values, (candidate) => candidate === nameIndex);
}

function containingArea(collection: FeatureCollection<Polygon | MultiPolygon, NamedArea['properties']>, position: Position) {
  return collection.features.find((feature) => turf.booleanPointInPolygon(point(position), feature));
}

export function districtAt(position: Position) {
  return containingArea(supervisorDistricts, position);
}

export function landmassAt(position: Position) {
  return containingArea(sfLandmasses, position);
}

export function zipCodeAt(position: Position) {
  return containingArea(zipCodeAreas, position);
}

function distanceToPolygon(position: Position, feature: Feature<Polygon | MultiPolygon>) {
  if (turf.booleanPointInPolygon(point(position), feature)) return 0;
  const lines = turf.flatten(feature).features.map((polygon) => turf.polygonToLine(polygon));
  return Math.min(...lines.flatMap((line) => turf.flatten(line).features.map((part) => turf.pointToLineDistance(point(position), part, { units: 'miles' }))));
}

export function nearestWaterDistance(position: Position) {
  return Math.min(nearestCoastlineDistance(position), ...waterBodies.features.map((feature) => distanceToPolygon(position, feature)));
}

export function waterDistanceArea(origin: Position) {
  const threshold = nearestWaterDistance(origin);
  const buffered = [
    turf.buffer(coastline, threshold, { units: 'miles', steps: 24 }) as Area,
    ...waterBodies.features.map((feature) => turf.buffer(feature, threshold, { units: 'miles', steps: 24 }) as Area),
  ];
  const union = buffered.length === 1 ? buffered[0] : turf.union(turf.featureCollection(buffered)) as Area;
  return clipToFrame(union);
}

export function normalizedStationNameLength(name: string) {
  return name.replace(/\bstation\b/gi, '').replaceAll('.', '').trim().length;
}
