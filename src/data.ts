import raw from './data/sf-pois.json';

export const SF_BOUNDS = { south: 37.7, west: -122.53, north: 37.84, east: -122.35 };
export const SF_CENTER = { lat: 37.77, lng: -122.44 };

export const PARTITION_CATEGORIES = [
  'mountain',
  'dog-park',
  'golf-course',
  'museum',
  'movie-theater',
  'library',
  'hospital',
  'foreign-consulate',
  'farmers-market',
] as const;

export const TENTACLE_CATEGORIES = ['museum', 'library', 'movie-theater', 'hospital', 'aquarium', 'transit-route'] as const;

export type PartitionCategory = (typeof PARTITION_CATEGORIES)[number];
export type PoiCategory =
  | PartitionCategory
  | 'game-valid-station'
  | 'rail-station'
  | 'aquarium'
  | 'muni-stop'
  | 'stairway';

export type Poi = {
  id: string;
  name: string;
  category: PoiCategory;
  lat: number;
  lng: number;
  sourceSheet: string;
  sourceRow: number;
  sourceObjectId: string;
  coordinateSource: 'workbook' | 'spreadsheet-google-maps-link' | 'geocoded-spreadsheet-address';
  address?: string;
  notes?: string;
  sourceMapUrl?: string;
};

export const CATEGORY_LABELS: Record<PoiCategory, string> = {
  mountain: 'Mountains (>400ft)',
  'dog-park': 'Dog parks',
  'golf-course': 'Golf courses',
  museum: 'Museums',
  'movie-theater': 'Movie theaters',
  library: 'Libraries',
  hospital: 'Hospitals',
  'foreign-consulate': 'Foreign consulates',
  'farmers-market': 'Farmers markets',
  'game-valid-station': 'Transit stations',
  'rail-station': 'Rail stations',
  aquarium: 'Aquariums',
  'muni-stop': 'All Muni stops',
  stairway: 'Stairways',
};

export const provenance = raw.provenance;
export const pois = raw.pois as Poi[];

export function validatePois(items: Poi[] = pois) {
  const ids = new Set<string>();
  for (const poi of items) {
    const validId = poi.id.startsWith(`sf:${poi.category}:`) && poi.id.length > `sf:${poi.category}:`.length;
    if (
      !validId ||
      ids.has(poi.id) ||
      !Number.isFinite(poi.lat) ||
      !Number.isFinite(poi.lng) ||
      poi.lat < SF_BOUNDS.south ||
      poi.lat > SF_BOUNDS.north ||
      poi.lng < SF_BOUNDS.west ||
      poi.lng > SF_BOUNDS.east ||
      !poi.sourceSheet ||
      !poi.sourceObjectId ||
      poi.sourceRow < 2
    ) {
      throw new Error(`Invalid SF dataset POI: ${poi.id}`);
    }
    ids.add(poi.id);
  }
  return true;
}
