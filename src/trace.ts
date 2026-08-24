import * as turf from '@turf/turf';
import type { Feature, LineString } from 'geojson';
import type { Position } from './types';

export function pathDistanceMiles(points: Position[]) {
  if (points.length < 2) return 0;
  return turf.length(turf.lineString(points.map((position) => [position.lng, position.lat])), { units: 'miles' });
}

export function pathGeoJson(points: Position[]): Feature<LineString> | undefined {
  if (points.length < 2) return undefined;
  return turf.lineString(points.map((position) => [position.lng, position.lat]), { kind: 'hider-trace' });
}
