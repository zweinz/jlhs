import type { Feature, MultiPolygon, Polygon } from 'geojson';

export type Position = { lat: number; lng: number };
export type QuestionKind =
  | 'radar'
  | 'radius'
  | 'thermometer'
  | 'measuring'
  | 'coastline'
  | 'tentacle'
  | 'photo-reference'
  | 'endgame-confirmation'
  | 'direction'
  | 'closer'
  | 'farther'
  | 'matching-region'
  | 'intersection'
  | 'exclusion';
export type Answer = 'yes' | 'no' | 'warmer' | 'colder' | 'closer' | 'farther' | 'null' | 'not-within-reach';
export type Eligibility = 'in' | 'out';
export interface Constraint {
  id: string;
  name: string;
  kind: QuestionKind;
  enabled: boolean;
  answer: Answer;
  answerSet?: boolean;
  origin: Position;
  originSet?: boolean;
  originMapUrl?: string;
  target?: Position;
  targetSet?: boolean;
  targetMapUrl?: string;
  distanceMiles?: number;
  direction?: 'north' | 'south' | 'east' | 'west';
  regionId?: string;
  category?: string;
}
export type Area = Feature<Polygon | MultiPolygon>;
export type AreaDisplayMode = 'allowed-green' | 'excluded-red';
export type TransitScope = 'all' | 'primary';
export type ManualReachRegion = {
  id: string;
  points: Position[];
};
export type ManualReachBoundary = {
  enabled: boolean;
  visible: boolean;
  regions: ManualReachRegion[];
};
export interface SharedState {
  version: 2;
  constraints: Constraint[];
  layers: Record<string, boolean>;
  viewport: { center: Position; zoom: number };
  mode: 'seeker' | 'hider';
  hiderPosition?: Position;
  hiderMapUrl?: string;
  stationZoneMiles: number;
  areaDisplayMode: AreaDisplayMode;
  transitScope: TransitScope;
  stationStatuses: Record<string, Eligibility>;
  routeStatuses: Record<string, Eligibility>;
  endGameActive?: boolean;
  manualReachBoundary?: ManualReachBoundary;
}
