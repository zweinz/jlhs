import * as turf from '@turf/turf';
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import raw from './data/no-hide-zones.json';
import { SF_BOUNDS } from './data';
import type { Area, Position } from './types';

type ZoneProperties = { id: string; name: string; boundary: string };

const source = raw as FeatureCollection<Polygon, ZoneProperties> & {
  provenance: { sourceUrl: string; method: string; reviewed: string; bufferFeet: number };
};
const frame = turf.bboxPolygon([SF_BOUNDS.west, SF_BOUNDS.south, SF_BOUNDS.east, SF_BOUNDS.north]) as Area;

export const noHideZoneProvenance = source.provenance;
export const noHideZones = source;
export const NO_HIDE_BUFFER_MILES = source.provenance.bufferFeet / 5280;

export const bufferedNoHideZones: FeatureCollection<Polygon | MultiPolygon, ZoneProperties> = turf.featureCollection(
  source.features.flatMap((feature) => {
    const buffered = turf.buffer(feature, NO_HIDE_BUFFER_MILES, { units: 'miles', steps: 32 });
    if (!buffered) return [];
    const clipped = turf.intersect(turf.featureCollection([frame, buffered])) as Area | null;
    return clipped ? [{ ...clipped, properties: feature.properties }] : [];
  }),
);

const excluded = turf.union(bufferedNoHideZones) as Area;
export const allowedHidingArea = (turf.difference(turf.featureCollection([frame, excluded])) as Area | null) ?? frame;

export function isHidingPositionAllowed(position: Position) {
  const point = turf.point([position.lng, position.lat]);
  return bufferedNoHideZones.features.every((feature) => !turf.booleanPointInPolygon(point, feature));
}
