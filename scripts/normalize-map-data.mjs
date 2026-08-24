import fs from 'node:fs';
import * as turf from '@turf/turf';

// Inputs are downloaded public DataSF GeoJSON snapshots in /private/tmp. ZIP boundaries come from:
// https://data.sfgov.org/resource/uq3t-6t53.geojson?$limit=500

const routesSource = JSON.parse(fs.readFileSync('/private/tmp/muni-simple-routes.geojson', 'utf8'));
const shorelineSource = JSON.parse(fs.readFileSync('/private/tmp/sf-shoreline.geojson', 'utf8'));
const districtsSource = JSON.parse(fs.readFileSync('/private/tmp/sf-districts.geojson', 'utf8'));
const waterSource = JSON.parse(fs.readFileSync('/private/tmp/sf-water.geojson', 'utf8'));
const zipSource = JSON.parse(fs.readFileSync('/private/tmp/sf-zipcodes.geojson', 'utf8'));

const railLines = new Set(['F', 'J', 'K', 'L', 'M', 'N', 'T']);
const routeFeatures = routesSource.features
  .map((feature) => {
    const routeId = feature.properties.lineabbr.replace(/^0+/, '');
    const simplified = turf.simplify(feature, { tolerance: 0.00004, highQuality: true });
    return {
      type: 'Feature',
      properties: {
        routeId,
        name: routeId,
        direction: feature.properties.direction,
        mode: railLines.has(routeId) ? 'light-rail' : routeId.endsWith('R') ? 'rapid-muni' : 'other-transit',
      },
      geometry: simplified.geometry,
    };
  });

const flattened = turf.flatten(shorelineSource).features;
const mainland = flattened.reduce((largest, candidate) =>
  !largest || turf.area(candidate) > turf.area(largest) ? candidate : largest,
);
const ring = mainland.geometry.coordinates[0];
const kept = [];
let current = [];
for (let index = 1; index < ring.length; index += 1) {
  const a = ring[index - 1];
  const b = ring[index];
  const isSouthCountyLine = a[1] < 37.711 && b[1] < 37.711 && a[0] < -122.385 && b[0] < -122.385;
  if (isSouthCountyLine) {
    if (current.length > 1) kept.push(current);
    current = [];
  } else {
    if (current.length === 0) current.push(a);
    current.push(b);
  }
}
if (current.length > 1) kept.push(current);

// The rulebook explicitly treats coastline precision as approximate; ~35 m simplification keeps mobile buffering fast.
const coastline = turf.simplify(turf.multiLineString(kept), { tolerance: 0.00032, highQuality: true });

const districts = districtsSource.features.map((feature) => ({
  ...turf.simplify(feature, { tolerance: 0.00008, highQuality: true }),
  properties: { id: `district-${feature.properties.sup_dist}`, name: `District ${feature.properties.sup_dist}` },
}));

const waters = waterSource.features.map((feature) => ({
  ...turf.simplify(feature, { tolerance: 0.00006, highQuality: true }),
  properties: {
    id: `water-${feature.properties.objectid}`,
    name: feature.properties.body_name || `Unnamed ${feature.properties.body_type.toLowerCase()}`,
    type: feature.properties.body_type,
  },
}));

const zipGroups = new Map();
for (const feature of zipSource.features) {
  const zipCode = feature.properties.zip_code;
  zipGroups.set(zipCode, [...(zipGroups.get(zipCode) ?? []), feature]);
}
const zipCodes = [...zipGroups.entries()].map(([zipCode, features]) => {
  const merged = features.length === 1 ? features[0] : turf.union(turf.featureCollection(features));
  return {
    ...turf.simplify(merged, { tolerance: 0.000045, highQuality: true }),
    properties: { id: `zip-${zipCode}`, name: zipCode },
  };
});

const treasureIsland = flattened
  .filter((feature) => {
    const [lng, lat] = turf.centroid(feature).geometry.coordinates;
    return lng > -122.39 && lng < -122.34 && lat > 37.79 && lat < 37.84;
  })
  .reduce((largest, candidate) => (!largest || turf.area(candidate) > turf.area(largest) ? candidate : largest), null);
const stowLake = waterSource.features.find((feature) => /stow|blue heron/i.test(feature.properties.body_name));
const strawberryRing = stowLake.geometry.coordinates[0]
  .slice(1)
  .reduce((largest, candidate) =>
    turf.area(turf.polygon([candidate])) > turf.area(turf.polygon([largest])) ? candidate : largest,
  );
const strawberryHill = turf.polygon([strawberryRing]);
const mapFrame = turf.bboxPolygon([-122.53, 37.7, -122.35, 37.84]);
const everythingElse = turf.difference(
  turf.featureCollection([
    turf.difference(turf.featureCollection([mapFrame, treasureIsland])),
    strawberryHill,
  ]),
);
const landmasses = [
  { ...turf.simplify(treasureIsland, { tolerance: 0.00008, highQuality: true }), properties: { id: 'landmass-treasure-island', name: 'Treasure Island' } },
  { ...turf.simplify(strawberryHill, { tolerance: 0.00003, highQuality: true }), properties: { id: 'landmass-strawberry-hill', name: 'Strawberry Hill' } },
  { ...everythingElse, properties: { id: 'landmass-mainland', name: 'Everything else in San Francisco' } },
];

fs.writeFileSync(
  'src/data/transit-routes.json',
  `${JSON.stringify({
    type: 'FeatureCollection',
    provenance: {
      dataset: 'Muni Simple Routes',
      sourceUrl: 'https://data.sfgov.org/Transportation/Muni-Simple-Routes/9exe-acju',
      retrieved: '2026-08-24',
      license: 'Open Data Commons Public Domain Dedication and License',
      scope: 'Current Muni routes (inbound and outbound patterns), classified as light rail, Rapid Muni, or other transit',
    },
    features: routeFeatures,
  })}\n`,
);

fs.writeFileSync(
  'src/data/rulebook-areas.json',
  `${JSON.stringify({
    provenance: {
      districts: {
        dataset: 'Current Supervisor Districts',
        sourceUrl: 'https://data.sfgov.org/d/cqbw-m5m3',
        retrieved: '2026-08-24',
        license: 'Open Data Commons Public Domain Dedication and License',
      },
      water: {
        dataset: 'Water bodies',
        sourceUrl: 'https://data.sfgov.org/d/j829-i3ix',
        retrieved: '2026-08-24',
        license: 'Open Data Commons Public Domain Dedication and License',
      },
      zipCodes: {
        dataset: 'San Francisco ZIP Codes',
        sourceUrl: 'https://data.sfgov.org/dataset/San-Francisco-ZIP-Codes/uq3t-6t53',
        retrieved: '2026-08-24',
        license: 'Open Data Commons Public Domain Dedication and License',
        note: 'Generalized areal representations of USPS delivery routes; split records merged by ZIP code',
      },
      landmasses: {
        source: 'SF Shoreline and Islands plus the Stow Lake island ring',
        note: 'SF-modified landmasses: Treasure Island, Strawberry Hill, and everything else',
      },
    },
    districts: { type: 'FeatureCollection', features: districts },
    waters: { type: 'FeatureCollection', features: waters },
    zipCodes: { type: 'FeatureCollection', features: zipCodes },
    landmasses: { type: 'FeatureCollection', features: landmasses },
  })}\n`,
);

fs.writeFileSync(
  'src/data/coastline.json',
  `${JSON.stringify({
    type: 'FeatureCollection',
    provenance: {
      dataset: 'SF Shoreline and Islands',
      sourceUrl: 'https://data.sfgov.org/d/txuc-3kzm',
      retrieved: '2026-08-24',
      license: 'Open Data Commons Public Domain Dedication and License',
      scope: 'Mainland shoreline only; the straight southern county boundary is omitted',
    },
    features: [{ ...coastline, properties: { id: 'sf-mainland-coastline' } }],
  })}\n`,
);
