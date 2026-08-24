import { describe, expect, it } from 'vitest';
import resolveMapLink from '../api/resolve-map-link';
import { googleMapsLinkForPosition, isGoogleMapsUrl, parseCoordinatesFromGoogleMapsUrl } from './mapLinks';

describe('Google Maps link coordinates', () => {
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
});
