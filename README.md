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

`src/questions.ts` is the rulebook-facing question catalog; `src/types.ts` separates definitions and answers; `src/geometry.ts` implements radii, warmer/colder thermometers, directional half-planes, closer/farther comparisons, matching Voronoi regions, intersections, and exclusions. The initial domain is a documented SF bounding rectangle; coastline clipping is intentionally deferred. Every POI-backed matching category allowed by the SF rulebook has an independent layer: mountains, dog parks, golf courses, museums, movie theaters, libraries, hospitals, foreign consulates, and farmers markets. `src/share.ts` validates and version-controls URL payloads before restoration.

## Sharing and accessibility

**Share** serializes constraints, enabled layers, map center, and zoom into a version-1 `?config=` URL and copies it when clipboard access is available. Invalid or oversized payloads are rejected. Native labels, visible focus states, status announcements, responsive controls, a source legend, and Google/data attribution are included.
