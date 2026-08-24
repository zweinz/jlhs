import * as turf from '@turf/turf';
import { pois } from './data';
import { constraintArea, nearestPoi } from './geometry';
import { distanceToRoute, nearestCoastlineDistance, routesForStation, transitRoutes, validStations } from './transit';
import type { Area, Constraint, Position } from './types';
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

export function hiderAnswer(constraint: Constraint, hider: Position, regions: Record<string, Area>) {
  if (constraint.kind === 'radar' || constraint.kind === 'radius') {
    return distance(hider, constraint.origin) <= (constraint.distanceMiles ?? 1) ? 'Yes' : 'No';
  }
  if (constraint.kind === 'thermometer') {
    const end = constraint.target ?? constraint.origin;
    return distance(hider, end) < distance(hider, constraint.origin) ? 'Hotter' : 'Colder';
  }
  if (constraint.kind === 'measuring') {
    if (constraint.category === 'sea-level') {
      return elevationAt(hider) < elevationAt(constraint.origin) ? 'Closer (lower elevation)' : 'Farther (higher elevation)';
    }
    if (constraint.category === 'body-of-water') {
      return nearestWaterDistance(hider) < nearestWaterDistance(constraint.origin) ? 'Closer' : 'Farther';
    }
    if (constraint.category === 'coastline') {
      return nearestCoastlineDistance(hider) < nearestCoastlineDistance(constraint.origin) ? 'Closer' : 'Farther';
    }
    const hiderNearest = nearestPoi(constraint.category ?? 'rail-station', hider);
    const seekerNearest = nearestPoi(constraint.category ?? 'rail-station', constraint.origin);
    if (!hiderNearest || !seekerNearest) return 'Null — no matching locations are inside the map';
    return distance(hider, hiderNearest) < distance(constraint.origin, seekerNearest) ? 'Closer' : 'Farther';
  }
  if (constraint.kind === 'coastline') {
    return nearestCoastlineDistance(hider) < nearestCoastlineDistance(constraint.origin) ? 'Closer' : 'Farther';
  }
  if (constraint.kind === 'matching-region') {
    const category = constraint.category ?? 'museum';
    if (category === 'transit-route') {
      const nearestStation = validStations.reduce((best, station) =>
        distance(hider, station) < distance(hider, best) ? station : best,
      );
      return routesForStation(nearestStation.id).includes(constraint.regionId ?? '')
        ? `Yes — ${constraint.regionId} stops at ${nearestStation.name}`
        : `No — ${constraint.regionId} does not stop at ${nearestStation.name}`;
    }
    if (category === 'station-name-length') {
      const seekerStation = nearestPoi('game-valid-station', constraint.origin);
      const hiderStation = nearestPoi('game-valid-station', hider);
      if (!seekerStation || !hiderStation) return 'Null — no valid station is inside the map';
      const seekerLength = normalizedStationNameLength(seekerStation.name);
      const hiderLength = normalizedStationNameLength(hiderStation.name);
      return seekerLength === hiderLength
        ? `Yes — both names have ${hiderLength} characters`
        : `No — seeker: ${seekerLength}; hider: ${hiderLength} characters`;
    }
    if (category === 'street-path') {
      const seekerStreet = nearestStreet(constraint.origin);
      const hiderStreet = nearestStreet(hider);
      return seekerStreet === hiderStreet ? `Yes — ${hiderStreet}` : `No — seeker: ${seekerStreet}; hider: ${hiderStreet}`;
    }
    if (category === 'supervisor-district') {
      const seekerDistrict = districtAt(constraint.origin)?.properties.name;
      const hiderDistrict = districtAt(hider)?.properties.name;
      return seekerDistrict === hiderDistrict ? `Yes — ${hiderDistrict}` : `No — seeker: ${seekerDistrict ?? 'outside'}; hider: ${hiderDistrict ?? 'outside'}`;
    }
    if (category === 'landmass') {
      const seekerLandmass = landmassAt(constraint.origin)?.properties.name;
      const hiderLandmass = landmassAt(hider)?.properties.name;
      return seekerLandmass === hiderLandmass ? `Yes — ${hiderLandmass}` : `No — seeker: ${seekerLandmass ?? 'outside'}; hider: ${hiderLandmass ?? 'outside'}`;
    }
    if (category === 'zip-code') {
      const seekerZip = zipCodeAt(constraint.origin)?.properties.name;
      const hiderZip = zipCodeAt(hider)?.properties.name;
      return seekerZip === hiderZip ? `Yes — ${hiderZip}` : `No — seeker: ${seekerZip ?? 'outside'}; hider: ${hiderZip ?? 'outside'}`;
    }
    const seekerNearest = nearestPoi(category, constraint.origin);
    const hiderNearest = nearestPoi(category, hider);
    if (!seekerNearest || !hiderNearest) return 'Null — no matching locations are inside the map';
    return seekerNearest.id === hiderNearest.id
      ? `Yes — ${hiderNearest.name}`
      : `No — seeker: ${seekerNearest.name}; hider: ${hiderNearest.name}`;
  }
  if (constraint.kind === 'tentacle') {
    const category = constraint.category ?? 'museum';
    const reach = constraint.distanceMiles ?? 1;
    if (category === 'transit-route') {
      const eligible = transitRoutes.filter((route) => distanceToRoute(constraint.origin, route) <= reach);
      if (eligible.length === 0) return 'Not within reach';
      const nearest = eligible.reduce((best, route) =>
        distanceToRoute(hider, route) < distanceToRoute(hider, best) ? route : best,
      );
      return distanceToRoute(hider, nearest) <= reach ? `${nearest.id} line` : 'Not within reach';
    }
    const eligible = pois.filter(
      (poi) => poi.category === category && distance(constraint.origin, poi) <= reach,
    );
    if (eligible.length === 0) return 'Not within reach';
    const nearest = eligible.reduce((best, candidate) =>
      distance(hider, candidate) < distance(hider, best) ? candidate : best,
    );
    return distance(hider, nearest) <= reach ? nearest.name : 'Not within reach';
  }
  if (constraint.kind === 'photo-reference') return 'Take the requested photo from your current location';
  return turf.booleanPointInPolygon(point(hider), constraintArea(constraint, regions))
    ? 'Inside this answer area'
    : 'Outside this answer area';
}
