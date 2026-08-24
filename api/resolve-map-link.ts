import { isGoogleMapsUrl, parseCoordinatesFromGoogleMapsUrl, parsePlaceQueryFromGoogleMapsUrl } from '../src/mapLinks';

export const config = { runtime: 'edge' };

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
      if (query) return Response.json({ query });
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
