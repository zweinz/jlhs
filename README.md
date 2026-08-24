# SF Hiding Area

A responsive React + TypeScript + Vite browser application that models San Francisco geographic-question answers as GeoJSON with Turf, then displays them with the Google Maps JavaScript API. Question/answer models and geometry live outside the renderer.

## Local development

Requires Node.js 20+. The checked-out local installation lives at `~/Sites/jlhs`. Copy `.env.example` to `.env`, add a Google Maps JavaScript API browser key, and restrict that key to your development and production origins. Credentials are ignored by Git.

```bash
cp .env.example .env
npm install
npm run dev
```

Open the Vite URL. Without a key the app deliberately shows an actionable error state. Run tests with `npm test`, produce an optimized bundle with `npm run build`, and inspect it locally with `npm run preview`.

## Deployment

The production deployment uses Vercel's free Hobby tier. Import the GitHub repository, keep the detected Vite settings (`npm run build`, output directory `dist`), and add `VITE_GOOGLE_MAPS_API_KEY` for Production, Preview, and Development. Because the key is delivered to browsers, protect it with Google Cloud HTTP-referrer restrictions for `http://localhost:*/*`, the production Vercel origin, and preview deployments, plus an API restriction to Maps JavaScript API.

## Data and architecture

`src/data/sf-pois.json` contains 3,760 complete geographic records from the SF workbook at spreadsheet `1VyhjPUGxNSybxBV7yFSEECI9sKcdJOME2TpFpAaXpok`, gid `252568279`, captured 2026-08-24. It covers every source tab containing geographic records; nine unfinished rows in the explicitly WIP stairway tab are recorded as skipped because they have no coordinates. Each POI retains its source sheet, row, object ID, coordinate source, and a stable `sf:<category>:<source-object-id>` identifier. Runtime validation rejects duplicates, malformed IDs, missing provenance, nonnumeric coordinates, and points outside the SF working bounds. Update the checked-in snapshot rather than fetching mutable spreadsheet data in a visitor's browser.

`src/questions.ts` is the rulebook-facing question catalog and keeps card notes, timing, rewards, and source pages with each question. `src/types.ts` separates definitions and answers; `src/geometry.ts` implements radar circles, true start/end thermometer bisectors, nearest-category measuring, fixed-center coastline comparisons, matching Voronoi regions, tentacle reach, transit-line matching, directional half-planes, intersections, and exclusions. Every POI-backed matching category allowed by the SF rulebook has an independent layer: mountains, dog parks, golf courses, museums, movie theaters, libraries, hospitals, foreign consulates, and farmers markets. `src/share.ts` validates and version-controls URL payloads before restoration.

`src/data/transit-routes.json` is a normalized, simplified snapshot of the public-domain DataSF **Muni Simple Routes** dataset, limited to the F/J/K/L/M/N/T light-rail lines and 5R/9R/14R/28R/38R Rapid Muni lines. `src/data/coastline.json` is derived from the public-domain DataSF **SF Shoreline and Islands** dataset; it keeps the mainland shoreline and removes the straight southern county boundary. `scripts/normalize-map-data.mjs` documents and reproduces both transformations from downloaded source files.

The 193 spreadsheet-defined valid stations have a Voronoi partition, touch-friendly markers, and configurable hiding-zone radii (default 0.25 miles). A station or an entire route can be marked in/out. When “Constrain feasible area to eligible zones” is enabled, route cuts and station cuts are applied before question constraints.

## Sharing and accessibility

**Share** serializes constraints, enabled layers, transit eligibility, map center, and zoom into a version-2 `?config=` URL and copies it when clipboard access is available. Version-1 links migrate safely. Invalid or oversized payloads are rejected. The precise hider position is deliberately omitted from shared URLs. Native labels, visible focus states, status announcements, responsive controls, a source legend, and Google/DataSF attribution are included.

Locations can be pasted as full or shortened Google Maps links. Full links are parsed in the browser; `/api/resolve-map-link` follows only allow-listed Google Maps short links and returns the shared pin coordinates. The resolver rejects arbitrary hosts. The layout is mobile-first: the map is placed before the controls on small screens, controls use touch-sized targets, and long layer/legend sections collapse.

Hider mode accepts a Google Maps pin or browser geolocation and calculates answers for radar, thermometer, nearest-category measuring, coastline, POI/transit matching, and tentacles. It does not silently write those calculated answers into the seeker state.

## Retrospective transit reachability

This iteration does not add a “how far in one hour” transit isochrone. Google Routes can query transit itineraries up to seven days in the past, but it requires a destination and does not return a reachable-area polygon in one request. The 511 SF Bay APIs expose scheduled departures and historical monthly GTFS feeds, but deriving a multimodal reachability area requires downloading the applicable feed and running a routing graph. That is deliberately deferred until there is a reliable single-call reachability service rather than multiplying route requests or presenting a misleading approximation.
