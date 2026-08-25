import { jsonError, unseal, type PhotoAsset } from '../_solo-session';

declare const process: { env: Record<string, string | undefined> };
export const config = { runtime: 'edge' };

export default async function handler(request: Request) {
  if (request.method !== 'GET') return jsonError('Use GET to load a Solo photo.', 405);
  try {
    const token = new URL(request.url).searchParams.get('token');
    if (!token) return jsonError('Photo token is missing.');
    const asset = await unseal<PhotoAsset>(token, 'solo-photo');
    const key = process.env.GOOGLE_MAPS_SERVER_API_KEY;
    if (!key) throw new Error('GOOGLE_MAPS_SERVER_API_KEY is not configured.');
    const url = new URL('https://maps.googleapis.com/maps/api/streetview');
    url.searchParams.set('size', '600x400');
    url.searchParams.set('pano', asset.panoramaId);
    url.searchParams.set('heading', String(asset.heading));
    url.searchParams.set('pitch', String(asset.pitch));
    url.searchParams.set('fov', String(asset.fov));
    url.searchParams.set('return_error_code', 'true');
    url.searchParams.set('key', key);
    const response = await fetch(url);
    if (!response.ok || !response.body) return jsonError('I cannot answer: Street View imagery is unavailable.', 404);
    return new Response(response.body, {
      headers: {
        'content-type': response.headers.get('content-type') ?? 'image/jpeg',
        'cache-control': 'private, no-store, max-age=0',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'The Solo photo is unavailable.', 400);
  }
}
