import type { Feature, MultiPolygon, Polygon } from 'geojson';

export type Position = { lat: number; lng: number };
export type QuestionKind =
  | 'radius'
  | 'thermometer'
  | 'direction'
  | 'closer'
  | 'farther'
  | 'matching-region'
  | 'intersection'
  | 'exclusion';
export type Answer = 'yes' | 'no' | 'warmer' | 'colder';
export interface Constraint {
  id: string;
  name: string;
  kind: QuestionKind;
  enabled: boolean;
  answer: Answer;
  origin: Position;
  originMapUrl?: string;
  target?: Position;
  targetMapUrl?: string;
  distanceMiles?: number;
  direction?: 'north' | 'south' | 'east' | 'west';
  regionId?: string;
}
export type Area = Feature<Polygon | MultiPolygon>;
export interface SharedState {
  version: 1;
  constraints: Constraint[];
  layers: Record<string, boolean>;
  viewport: { center: Position; zoom: number };
}
