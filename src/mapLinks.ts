import type { Position } from './types';

const GOOGLE_MAPS_HOSTS = new Set(['maps.app.goo.gl', 'goo.gl', 'maps.google.com']);

export function isGoogleMapsUrl(value: string) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return GOOGLE_MAPS_HOSTS.has(host) || host === 'google.com' || host.endsWith('.google.com');
  } catch {
    return false;
  }
}

function position(lat: string, lng: string): Position | null {
  const parsed = { lat: Number(lat), lng: Number(lng) };
  return Number.isFinite(parsed.lat) && Number.isFinite(parsed.lng) ? parsed : null;
}

export function parseCoordinatesFromGoogleMapsUrl(value: string): Position | null {
  if (!isGoogleMapsUrl(value)) return null;
  const decoded = decodeURIComponent(value);
  const dataMatch = decoded.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (dataMatch) return position(dataMatch[1], dataMatch[2]);
  const atMatch = decoded.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (atMatch) return position(atMatch[1], atMatch[2]);
  const url = new URL(value);
  for (const key of ['query', 'q', 'll']) {
    const queryMatch = url.searchParams.get(key)?.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (queryMatch) return position(queryMatch[1], queryMatch[2]);
  }
  return null;
}

export function parsePlaceQueryFromGoogleMapsUrl(value: string): string | null {
  if (!isGoogleMapsUrl(value)) return null;
  const url = new URL(value);
  for (const key of ['query', 'q']) {
    const query = url.searchParams.get(key)?.trim();
    const coordinates = query?.match(/^\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*$/);
    if (query && query.length <= 500 && !coordinates) return query;
  }
  return null;
}

async function geocodeGoogleMapsQuery(query: string): Promise<Position> {
  if (!globalThis.google?.maps?.Geocoder) {
    throw new Error('The map is still loading. Wait a moment and try the link again.');
  }
  const { results } = await new google.maps.Geocoder().geocode({ address: query });
  const location = results[0]?.geometry.location;
  if (!location) throw new Error('Google Maps could not locate the place shared by that link.');
  return { lat: location.lat(), lng: location.lng() };
}

export async function resolveGoogleMapsLink(value: string): Promise<Position> {
  if (!isGoogleMapsUrl(value)) throw new Error('Paste a Google Maps link.');
  const direct = parseCoordinatesFromGoogleMapsUrl(value);
  if (direct) return direct;
  const response = await fetch(`/api/resolve-map-link?url=${encodeURIComponent(value)}`);
  const body = (await response.json()) as { position?: Position; query?: string; error?: string };
  if (!response.ok) throw new Error(body.error ?? 'Could not resolve that Google Maps link.');
  if (body.position) return body.position;
  if (body.query) return geocodeGoogleMapsQuery(body.query);
  throw new Error(body.error ?? 'Could not resolve that Google Maps link.');
}

export function googleMapsLinkForPosition(value: Position) {
  return `https://www.google.com/maps/search/?api=1&query=${value.lat},${value.lng}`;
}
