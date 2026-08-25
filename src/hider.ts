import * as turf from '@turf/turf';
import { pois } from './data';
import { constraintArea, nearestPoi } from './geometry';
import { distanceToRoute, nearestCoastlineDistance, primaryTransitRoutes, routesForStation, transitRoutes, validStations } from './transit';
import type { Answer, Area, Constraint, Position } from './types';
import {
  districtAt,
  elevationAt,
  landmassAt,
  nearestStreet,
  nearestWaterDistance,
  normalizedStationNameLength,
  zipCodeAt,
} from './rulebookGeometry';

const point = (position: Position) => turf.point([position.lng, position.lat]);
const distance = (a: Position, b: Position) => turf.distance(point(a), point(b), { units: 'miles' });

export type HiderAnswerResult = {
  answer?: Answer;
  displayText: string;
  resolvedRegionId?: string;
};

export function solveHiderQuestion(constraint: Constraint, hider: Position, regions: Record<string, Area> = {}): HiderAnswerResult {
  if (constraint.kind === 'radar' || constraint.kind === 'radius') {
    const yes = distance(hider, constraint.origin) <= (constraint.distanceMiles ?? 1);
    return { answer: yes ? 'yes' : 'no', displayText: yes ? 'Yes' : 'No' };
  }
  if (constraint.kind === 'thermometer') {
    const end = constraint.target ?? constraint.origin;
    const hotter = distance(hider, end) < distance(hider, constraint.origin);
    return { answer: hotter ? 'warmer' : 'colder', displayText: hotter ? 'Hotter' : 'Colder' };
  }
  if (constraint.kind === 'measuring') {
    if (constraint.category === 'sea-level') {
      const closer = elevationAt(hider) < elevationAt(constraint.origin);
      return { answer: closer ? 'closer' : 'farther', displayText: closer ? 'Closer (lower elevation)' : 'Farther (higher elevation)' };
    }
    if (constraint.category === 'body-of-water') {
      const closer = nearestWaterDistance(hider) < nearestWaterDistance(constraint.origin);
      return { answer: closer ? 'closer' : 'farther', displayText: closer ? 'Closer' : 'Farther' };
    }
    if (constraint.category === 'coastline') {
      const closer = nearestCoastlineDistance(hider) < nearestCoastlineDistance(constraint.origin);
      return { answer: closer ? 'closer' : 'farther', displayText: closer ? 'Closer' : 'Farther' };
    }
    const hiderNearest = nearestPoi(constraint.category ?? 'rail-station', hider);
    const seekerNearest = nearestPoi(constraint.category ?? 'rail-station', constraint.origin);
    if (!hiderNearest || !seekerNearest) return { displayText: 'Null — no matching locations are inside the map' };
    const closer = distance(hider, hiderNearest) < distance(constraint.origin, seekerNearest);
    return { answer: closer ? 'closer' : 'farther', displayText: closer ? 'Closer' : 'Farther' };
  }
  if (constraint.kind === 'coastline') {
    const closer = nearestCoastlineDistance(hider) < nearestCoastlineDistance(constraint.origin);
    return { answer: closer ? 'closer' : 'farther', displayText: closer ? 'Closer' : 'Farther' };
  }
  if (constraint.kind === 'matching-region') {
    const category = constraint.category ?? 'museum';
    if (category === 'transit-route') {
      const nearestStation = validStations.reduce((best, station) =>
        distance(hider, station) < distance(hider, best) ? station : best,
      );
      const yes = routesForStation(nearestStation.id).includes(constraint.regionId ?? '');
      return {
        answer: yes ? 'yes' : 'no',
        displayText: yes
          ? `Yes — ${constraint.regionId} stops at ${nearestStation.name}`
          : `No — ${constraint.regionId} does not stop at ${nearestStation.name}`,
      };
    }
    if (category === 'station-name-length') {
      const seekerStation = nearestPoi('game-valid-station', constraint.origin);
      const hiderStation = nearestPoi('game-valid-station', hider);
      if (!seekerStation || !hiderStation) return { displayText: 'Null — no station is inside the map' };
      const seekerLength = normalizedStationNameLength(seekerStation.name);
      const hiderLength = normalizedStationNameLength(hiderStation.name);
      const yes = seekerLength === hiderLength;
      return { answer: yes ? 'yes' : 'no', displayText: yes
        ? `Yes — both names have ${hiderLength} characters`
        : `No — seeker: ${seekerLength}; hider: ${hiderLength} characters` };
    }
    if (category === 'street-path') {
      const seekerStreet = nearestStreet(constraint.origin);
      const hiderStreet = nearestStreet(hider);
      const yes = seekerStreet === hiderStreet;
      return { answer: yes ? 'yes' : 'no', displayText: yes ? `Yes — ${hiderStreet}` : `No — seeker: ${seekerStreet}; hider: ${hiderStreet}` };
    }
    if (category === 'supervisor-district') {
      const seekerDistrict = districtAt(constraint.origin)?.properties.name;
      const hiderDistrict = districtAt(hider)?.properties.name;
      const yes = seekerDistrict === hiderDistrict;
      return { answer: yes ? 'yes' : 'no', displayText: yes ? `Yes — ${hiderDistrict}` : `No — seeker: ${seekerDistrict ?? 'outside'}; hider: ${hiderDistrict ?? 'outside'}` };
    }
    if (category === 'landmass') {
      const seekerLandmass = landmassAt(constraint.origin)?.properties.name;
      const hiderLandmass = landmassAt(hider)?.properties.name;
      const yes = seekerLandmass === hiderLandmass;
      return { answer: yes ? 'yes' : 'no', displayText: yes ? `Yes — ${hiderLandmass}` : `No — seeker: ${seekerLandmass ?? 'outside'}; hider: ${hiderLandmass ?? 'outside'}` };
    }
    if (category === 'zip-code') {
      const seekerZip = zipCodeAt(constraint.origin)?.properties.name;
      const hiderZip = zipCodeAt(hider)?.properties.name;
      const yes = seekerZip === hiderZip;
      return { answer: yes ? 'yes' : 'no', displayText: yes ? `Yes — ${hiderZip}` : `No — seeker: ${seekerZip ?? 'outside'}; hider: ${hiderZip ?? 'outside'}` };
    }
    const seekerNearest = nearestPoi(category, constraint.origin);
    const hiderNearest = nearestPoi(category, hider);
    if (!seekerNearest || !hiderNearest) return { displayText: 'Null — no matching locations are inside the map' };
    const yes = seekerNearest.id === hiderNearest.id;
    return { answer: yes ? 'yes' : 'no', displayText: yes
      ? `Yes — ${hiderNearest.name}`
      : `No — seeker: ${seekerNearest.name}; hider: ${hiderNearest.name}` };
  }
  if (constraint.kind === 'tentacle') {
    const category = constraint.category ?? 'museum';
    const reach = constraint.distanceMiles ?? 1;
    if (category === 'transit-route') {
      const eligible = primaryTransitRoutes.filter((route) => distanceToRoute(constraint.origin, route) <= reach);
      if (eligible.length === 0) return { answer: 'not-within-reach', displayText: 'Not within reach' };
      const nearest = eligible.reduce((best, route) =>
        distanceToRoute(hider, route) < distanceToRoute(hider, best) ? route : best,
      );
      const reached = distanceToRoute(hider, nearest) <= reach;
      return reached
        ? { answer: 'yes', displayText: `${nearest.id} line`, resolvedRegionId: nearest.id }
        : { answer: 'not-within-reach', displayText: 'Not within reach' };
    }
    const eligible = pois.filter(
      (poi) => poi.category === category && distance(constraint.origin, poi) <= reach,
    );
    if (eligible.length === 0) return { answer: 'not-within-reach', displayText: 'Not within reach' };
    const nearest = eligible.reduce((best, candidate) =>
      distance(hider, candidate) < distance(hider, best) ? candidate : best,
    );
    const reached = distance(hider, nearest) <= reach;
    return reached
      ? { answer: 'yes', displayText: nearest.name, resolvedRegionId: nearest.id }
      : { answer: 'not-within-reach', displayText: 'Not within reach' };
  }
  if (constraint.kind === 'photo-reference') return { displayText: 'Take the requested photo from your current location' };
  const inside = turf.booleanPointInPolygon(point(hider), constraintArea(constraint, regions));
  return { displayText: inside ? 'Inside this answer area' : 'Outside this answer area' };
}

export function hiderAnswer(constraint: Constraint, hider: Position, regions: Record<string, Area>) {
  return solveHiderQuestion(constraint, hider, regions).displayText;
}
