import { PARTITION_CATEGORIES, type PoiCategory } from './data';

export const VISIBLE_POI_PARTITIONS: PoiCategory[] = [
  ...PARTITION_CATEGORIES,
  'rail-station',
  'aquarium',
];

export function activePoiPartition(layers: Record<string, boolean>) {
  return VISIBLE_POI_PARTITIONS.find((category) => layers[category]);
}

export function selectPoiPartition(
  layers: Record<string, boolean>,
  selected?: PoiCategory,
) {
  const next = { ...layers };
  VISIBLE_POI_PARTITIONS.forEach((category) => {
    next[category] = category === selected;
  });
  return next;
}
