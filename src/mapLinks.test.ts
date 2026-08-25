import { describe, expect, it, vi } from 'vitest';
import resolveMapLink from '../api/resolve-map-link';
import { googleMapsLinkForPlace, googleMapsLinkForPosition, isGoogleMapsUrl, parseCoordinatesFromGoogleMapsUrl, parsePlaceQueryFromGoogleMapsUrl } from './mapLinks';

describe('Google Maps link coordinates', () => {
  it('builds a direct decimal-coordinate place URL with an explicit map center', () => {
    expect(googleMapsLinkForPosition({ lat: 37.7651667, lng: -122.3890556 })).toBe(
      'https://www.google.com/maps/place/37.7651667,-122.3890556/@37.7651667,-122.3890556,18z',
    );
  });

  it('builds a copyable exact-place URL without a Places Details request', () => {
    const url = new URL(googleMapsLinkForPlace('ChIJ-test_place', { lat: 37.77, lng: -122.44 }));
    expect(url.searchParams.get('api')).toBe('1');
    expect(url.searchParams.get('query')).toBe('37.77,-122.44');
    expect(url.searchParams.get('query_place_id')).toBe('ChIJ-test_place');
  });
  it('parses canonical place URLs', () => {
    expect(
      parseCoordinatesFromGoogleMapsUrl(
        'https://www.google.com/maps/place/Union+Square/@37.787994,-122.407437,17z/data=!4m6!3m5!1s0x0!8m2!3d37.787994!4d-122.407437',
      ),
    ).toEqual({ lat: 37.787994, lng: -122.407437 });
  });

  it('parses coordinate search links', () => {
    expect(parseCoordinatesFromGoogleMapsUrl(googleMapsLinkForPosition({ lat: 37.77, lng: -122.44 }))).toEqual({
      lat: 37.77,
      lng: -122.44,
    });
  });

  it('rejects non-Google links', () => {
    expect(isGoogleMapsUrl('https://example.com/maps/@37.77,-122.44')).toBe(false);
    expect(parseCoordinatesFromGoogleMapsUrl('https://example.com/maps/@37.77,-122.44')).toBeNull();
  });

  it('extracts an address query only from an allow-listed Google Maps URL', () => {
    expect(parsePlaceQueryFromGoogleMapsUrl('https://maps.google.com?q=330+Valdez+Ave,+San+Francisco,+CA+94127')).toBe(
      '330 Valdez Ave, San Francisco, CA 94127',
    );
    expect(parsePlaceQueryFromGoogleMapsUrl('https://example.com/?q=330+Valdez+Ave')).toBeNull();
  });
});

describe('map-link resolver API', () => {
  it('returns a direct coordinate without a network hop', async () => {
    const source = 'https://maps.google.com/?q=37.787994,-122.407437';
    const response = await resolveMapLink(
      new Request(`https://jlhs.vercel.app/api/resolve-map-link?url=${encodeURIComponent(source)}`),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ position: { lat: 37.787994, lng: -122.407437 } });
  });

  it('blocks arbitrary resolver targets', async () => {
    const response = await resolveMapLink(
      new Request('https://jlhs.vercel.app/api/resolve-map-link?url=https%3A%2F%2Fexample.com'),
    );
    expect(response.status).toBe(400);
  });

  it('follows the supplied maps.app.goo.gl location link', async () => {
    const source = 'https://maps.app.goo.gl/55eL3Ynzm9SE5uc97';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://www.google.com/maps/place/@37.7614347,-122.4240821,17z' },
      }),
    );
    const response = await resolveMapLink(
      new Request(`https://jlhs.vercel.app/api/resolve-map-link?url=${encodeURIComponent(source)}`),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ position: { lat: 37.7614347, lng: -122.4240821 } });
    expect(fetchMock).toHaveBeenCalledWith(expect.objectContaining({ href: source }), expect.objectContaining({ redirect: 'manual' }));
    fetchMock.mockRestore();
  });

  it('geocodes the place query exposed by an address-based short link', async () => {
    const source = 'https://maps.app.goo.gl/brySMBrgJW6g4iwa9?g_st=ic';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://maps.google.com?q=330+Valdez+Ave,+San+Francisco,+CA+94127&entry=gps' },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          result: { addressMatches: [{ coordinates: { x: -122.456379308028, y: 37.73311294576 } }] },
        }),
      );
    const response = await resolveMapLink(
      new Request(`https://jlhs.vercel.app/api/resolve-map-link?url=${encodeURIComponent(source)}`),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      position: { lat: 37.73311294576, lng: -122.456379308028 },
    });
    expect(fetchMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ hostname: 'geocoding.geo.census.gov' }),
    );
    fetchMock.mockRestore();
  });
});
