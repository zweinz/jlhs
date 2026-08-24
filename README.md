# SF Hiding Area

A responsive React + TypeScript + Vite browser application that models San Francisco geographic-question answers as GeoJSON with Turf, then displays them with the Google Maps JavaScript API. Question/answer models and geometry live outside the renderer.

## Local development

Requires Node.js 20+. Copy `.env.example` to `.env`, add a Google Maps JavaScript API browser key, and restrict that key to your development and production origins. Credentials are ignored by Git.

```bash
cp .env.example .env
npm install
npm run dev
```

Open the Vite URL. Without a key the app deliberately shows an actionable error state. Run tests with `npm test`, produce an optimized bundle with `npm run build`, and inspect it locally with `npm run preview`.

## Deployment

Set `VITE_GOOGLE_MAPS_API_KEY` in the deployment provider's build environment, run `npm ci && npm run build`, and publish `dist/` as a static site. For example, Netlify uses build command `npm run build` and publish directory `dist`; Cloudflare Pages uses the same values. Because the key is delivered to browsers, protect it with Google Cloud HTTP-referrer and API restrictions rather than treating it as a server secret.

## Data and architecture

`src/data/sf-pois.json` is the normalized SF subset of spreadsheet `1VyhjPUGxNSybxBV7yFSEECI9sKcdJOME2TpFpAaXpok`, gid `252568279`, captured 2026-08-24. Each record retains its source row and a stable `sf:<category>:<slug>` identifier. Runtime validation rejects duplicates, malformed IDs, nonnumeric coordinates, and points outside the SF working bounds. Update the checked-in snapshot rather than fetching mutable spreadsheet data in a visitor's browser.

`src/questions.ts` is the rulebook-facing question catalog; `src/types.ts` separates definitions and answers; `src/geometry.ts` implements radii, warmer/colder thermometers, directional half-planes, closer/farther comparisons, matching Voronoi regions, intersections, and exclusions. The initial domain is a documented SF bounding rectangle; coastline clipping is intentionally deferred. Museum and library partitions are independent layers derived solely from source POIs. `src/share.ts` validates and version-controls URL payloads before restoration.

## Sharing and accessibility

**Share** serializes constraints, enabled layers, map center, and zoom into a version-1 `?config=` URL and copies it when clipboard access is available. Invalid or oversized payloads are rejected. Native labels, visible focus states, status announcements, responsive controls, a source legend, and Google/data attribution are included.
