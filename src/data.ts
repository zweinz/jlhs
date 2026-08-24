import raw from './data/sf-pois.json';
export const SF_BOUNDS={south:37.70,west:-122.53,north:37.84,east:-122.35};
export type Poi={id:string;name:string;category:'museum'|'library';lat:number;lng:number;sourceRow:number};
export const provenance=raw.provenance;
export const pois=raw.pois as Poi[];
export function validatePois(items:Poi[]=pois){const ids=new Set<string>(); for(const p of items){if(!p.id.startsWith(`sf:${p.category}:`)||ids.has(p.id)||!Number.isFinite(p.lat)||!Number.isFinite(p.lng)||p.lat<SF_BOUNDS.south||p.lat>SF_BOUNDS.north||p.lng<SF_BOUNDS.west||p.lng>SF_BOUNDS.east||p.sourceRow<2)throw new Error(`Invalid SF dataset POI: ${p.id}`);ids.add(p.id)} return true}
