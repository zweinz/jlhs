import { PARTITION_CATEGORIES, type PoiCategory } from './data';

export const VISIBLE_POI_PARTITIONS: PoiCategory[] = [
  ...PARTITION_CATEGORIES,
  'rail-station',
  'aquarium',
];

export const GEOGRAPHIC_PARTITIONS = [
  { id: 'supervisor-districts', label: 'Supervisorial districts D1–D11' },
  { id: 'zip-codes', label: 'ZIP-code areas' },
  { id: 'landmasses', label: 'SF landmasses' },
  { id: 'no-hide-zones', label: 'No-hide zones' },
] as const;

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

export function activeMapPartition(layers: Record<string, boolean>) {
  return activePoiPartition(layers) ?? GEOGRAPHIC_PARTITIONS.find(({ id }) => layers[id])?.id;
}

export function selectMapPartition(layers: Record<string, boolean>, selected?: string) {
  let next = selectPoiPartition(layers);
  GEOGRAPHIC_PARTITIONS.forEach(({ id }) => { next[id] = false; });
  if (!selected) return next;
  if (GEOGRAPHIC_PARTITIONS.some(({ id }) => id === selected)) return { ...next, [selected]: true };
  return selectPoiPartition(next, selected as PoiCategory);
}
