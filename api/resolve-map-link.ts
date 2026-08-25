import { isGoogleMapsUrl, parseCoordinatesFromGoogleMapsUrl, parsePlaceQueryFromGoogleMapsUrl } from '../src/mapLinks';

export const config = { runtime: 'edge' };

type CensusResponse = {
  result?: { addressMatches?: Array<{ coordinates?: { x?: number; y?: number } }> };
};

async function geocodeStreetAddress(address: string) {
  const endpoint = new URL('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress');
  endpoint.searchParams.set('address', address);
  endpoint.searchParams.set('benchmark', 'Public_AR_Current');
  endpoint.searchParams.set('format', 'json');
  const response = await fetch(endpoint, { headers: { accept: 'application/json' } });
  if (!response.ok) return null;
  const body = (await response.json()) as CensusResponse;
  const coordinates = body.result?.addressMatches?.[0]?.coordinates;
  if (!Number.isFinite(coordinates?.x) || !Number.isFinite(coordinates?.y)) return null;
  return { lat: coordinates!.y!, lng: coordinates!.x! };
}

export function parseCoordinatesFromGoogleMapsEmbed(html: string) {
  const match = html.match(/\["0x[0-9a-f]+:0x[0-9a-f]+","(?:[^"\\]|\\.)*",\[(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\]\]/i);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

async function geocodeGoogleMapsPlace(value: URL) {
  let current = new URL(value);
  current.pathname = '/maps';
  current.searchParams.set('output', 'embed');
  for (let redirects = 0; redirects < 3; redirects += 1) {
    if (!isGoogleMapsUrl(current.href)) return null;
    const response = await fetch(current, {
      redirect: 'manual',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; SF-Hiding-Area/1.0)' },
    });
    const location = response.headers.get('location');
    if (location) {
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) return null;
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > 1_000_000) return null;
    return parseCoordinatesFromGoogleMapsEmbed(await response.text());
  }
  return null;
}

export default async function handler(request: Request) {
  const value = new URL(request.url).searchParams.get('url') ?? '';
  if (!isGoogleMapsUrl(value)) {
    return Response.json({ error: 'Only Google Maps links are supported.' }, { status: 400 });
  }
  const direct = parseCoordinatesFromGoogleMapsUrl(value);
  if (direct) return Response.json({ position: direct });
  try {
    let current = new URL(value);
    for (let redirects = 0; redirects < 8; redirects += 1) {
      if (!isGoogleMapsUrl(current.href)) {
        return Response.json({ error: 'The shared link redirected outside Google Maps.' }, { status: 400 });
      }
      const resolved = parseCoordinatesFromGoogleMapsUrl(current.href);
      if (resolved) return Response.json({ position: resolved });
      const query = parsePlaceQueryFromGoogleMapsUrl(current.href);
      if (query) {
        const geocoded = await geocodeStreetAddress(query);
        if (geocoded) return Response.json({ position: geocoded });
        const place = await geocodeGoogleMapsPlace(current);
        if (place) return Response.json({ position: place });
      }
      const response = await fetch(current, {
        redirect: 'manual',
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; SF-Hiding-Area/1.0)' },
      });
      const location = response.headers.get('location');
      if (!location) break;
      current = new URL(location, current);
    }
    return Response.json({ error: 'The shared link did not expose a coordinate or place pin.' }, { status: 422 });
  } catch {
    return Response.json({ error: 'Google Maps did not resolve the shared link.' }, { status: 502 });
  }
}
