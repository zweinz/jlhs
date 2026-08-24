import fs from 'node:fs';
import * as turf from '@turf/turf';

const routesSource = JSON.parse(fs.readFileSync('/private/tmp/muni-simple-routes.geojson', 'utf8'));
const shorelineSource = JSON.parse(fs.readFileSync('/private/tmp/sf-shoreline.geojson', 'utf8'));

const railLines = new Set(['F', 'J', 'K', 'L', 'M', 'N', 'T']);
const routeFeatures = routesSource.features
  .filter((feature) => railLines.has(feature.properties.lineabbr) || feature.properties.lineabbr.endsWith('R'))
  .map((feature) => {
    const routeId = feature.properties.lineabbr.replace(/^0+/, '');
    const simplified = turf.simplify(feature, { tolerance: 0.00004, highQuality: true });
    return {
      type: 'Feature',
      properties: {
        routeId,
        name: routeId,
        direction: feature.properties.direction,
        mode: railLines.has(routeId) ? 'light-rail' : 'rapid-muni',
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

fs.writeFileSync(
  'src/data/transit-routes.json',
  `${JSON.stringify({
    type: 'FeatureCollection',
    provenance: {
      dataset: 'Muni Simple Routes',
      sourceUrl: 'https://data.sfgov.org/Transportation/Muni-Simple-Routes/9exe-acju',
      retrieved: '2026-08-24',
      license: 'Open Data Commons Public Domain Dedication and License',
      scope: 'Current light-rail and Rapid Muni lines (inbound and outbound patterns)',
    },
    features: routeFeatures,
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
