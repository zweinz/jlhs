import { jsonError, unseal, type StreetOrientationAsset } from '../_solo-session';

export const config = { runtime: 'edge' };

const normalizedAxialBearing = (bearing: number) => ((bearing % 180) + 180) % 180;

export function streetOrientationSvg(bearing: number) {
  const radians = normalizedAxialBearing(bearing) * Math.PI / 180;
  const dx = Math.sin(radians) * 135;
  const dy = -Math.cos(radians) * 135;
  const x1 = (300 - dx).toFixed(2);
  const y1 = (225 - dy).toFixed(2);
  const x2 = (300 + dx).toFixed(2);
  const y2 = (225 + dy).toFixed(2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400" role="img" aria-label="Approximate nearest street orientation with north up">
  <rect width="600" height="400" rx="24" fill="#f8fafc"/>
  <path d="M300 56V20m0 0-10 16m10-16 10 16" fill="none" stroke="#0f172a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="300" y="78" text-anchor="middle" font-family="system-ui,sans-serif" font-size="22" font-weight="800" fill="#0f172a">N</text>
  <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#ffffff" stroke-width="18" stroke-linecap="round"/>
  <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#e11d48" stroke-width="9" stroke-linecap="round"/>
  <circle cx="${x1}" cy="${y1}" r="8" fill="#e11d48" stroke="#ffffff" stroke-width="4"/>
  <circle cx="${x2}" cy="${y2}" r="8" fill="#e11d48" stroke="#ffffff" stroke-width="4"/>
  <text x="300" y="382" text-anchor="middle" font-family="system-ui,sans-serif" font-size="18" font-weight="650" fill="#475569">Approximate nearest-street orientation</text>
</svg>`;
}

export default async function handler(request: Request) {
  if (request.method !== 'GET') return jsonError('Use GET to load a Solo street orientation.', 405);
  try {
    const token = new URL(request.url).searchParams.get('token');
    if (!token) return jsonError('Street-orientation token is missing.');
    const asset = await unseal<StreetOrientationAsset>(token, 'solo-street-orientation');
    if (!Number.isFinite(asset.bearing) || asset.bearing < 0 || asset.bearing >= 180) {
      return jsonError('The street orientation is invalid.');
    }
    return new Response(streetOrientationSvg(asset.bearing), {
      headers: {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'private, no-store, max-age=0',
        'content-security-policy': "default-src 'none'",
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'The Solo street orientation is unavailable.', 400);
  }
}
