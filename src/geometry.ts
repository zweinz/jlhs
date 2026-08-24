import * as turf from '@turf/turf';
import type {Area,Constraint} from './types';
import {SF_BOUNDS,pois} from './data';
const frame=()=>turf.bboxPolygon([SF_BOUNDS.west,SF_BOUNDS.south,SF_BOUNDS.east,SF_BOUNDS.north]) as Area;
const point=(p:{lat:number;lng:number})=>turf.point([p.lng,p.lat]);
const invert=(area:Area)=>turf.difference(turf.featureCollection([frame(),area])) as Area;
export function constraintArea(c:Constraint,regions:Record<string,Area>={}):Area{
  let area:Area;
  if(c.kind==='radius'||c.kind==='intersection'||c.kind==='exclusion') area=turf.circle(point(c.origin),c.distanceMiles??1,{units:'miles',steps:64}) as Area;
  else if(c.kind==='direction') {const b=SF_BOUNDS,o=c.origin,d=c.direction??'north'; const box=d==='north'?[b.west,o.lat,b.east,b.north]:d==='south'?[b.west,b.south,b.east,o.lat]:d==='east'?[o.lng,b.south,b.east,b.north]:[b.west,b.south,o.lng,b.north];area=turf.bboxPolygon(box) as Area}
  else if(c.kind==='matching-region'){area=regions[c.regionId??''];if(!area)throw new Error('Unknown matching region')}
  else {const target=c.target??c.origin; const radius=c.distanceMiles??turf.distance(point(c.origin),point(target),{units:'miles'});area=turf.circle(point(target),radius,{units:'miles',steps:64}) as Area; if(c.kind==='farther'||c.answer==='colder')area=invert(area)}
  if(c.kind==='exclusion'||c.answer==='no') area=invert(area); return area;
}
export function combineConstraints(cs:Constraint[],regions:Record<string,Area>={}):Area{let result=frame();for(const c of cs.filter(x=>x.enabled)){const next=turf.intersect(turf.featureCollection([result,constraintArea(c,regions)]));if(!next)return {type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[]}};result=next as Area}return result}
export function partition(category:'museum'|'library'){const selected=pois.filter(p=>p.category===category);const collection=turf.featureCollection(selected.map(p=>turf.point([p.lng,p.lat],{id:p.id,name:p.name})));const vor=turf.voronoi(collection,{bbox:[SF_BOUNDS.west,SF_BOUNDS.south,SF_BOUNDS.east,SF_BOUNDS.north]});const out:Record<string,Area>={};vor.features.forEach((f,i)=>{if(f)out[selected[i].id]=f as Area});return out}
export {frame as sfFrame};
