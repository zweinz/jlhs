import type { Position } from '../src/types';
import type { SoloPhase } from '../src/solo';

declare const process: { env: Record<string, string | undefined> };

export type SecretSoloSession = {
  kind: 'solo-session';
  version: 1;
  sessionId: string;
  createdAt: string;
  expiresAt: string;
  departureTime: string;
  salt: string;
  commitment: string;
  phase: SoloPhase;
  cardsDrawn: number;
  cardsKept?: number;
  questionUses: Record<string, number>;
  wideHeading: number;
  station: { id: string; name: string; position: Position };
  spot: Position;
  panorama: { id: string; date?: string };
  stationPanorama?: { id: string; date?: string };
  route: {
    durationSeconds: number;
    distanceMeters: number;
    departureTime: string;
    arrivalTime: string;
    summary: string[];
  };
};

export type PhotoAsset = {
  kind: 'solo-photo';
  version: 1;
  expiresAt: string;
  panoramaId: string;
  heading: number;
  pitch: number;
  fov: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64Url(bytes: Uint8Array) {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value: string) {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function encryptionKey(secret: string) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function secrets() {
  const current = process.env.SOLO_SESSION_SECRET;
  if (!current || current.length < 24) throw new Error('SOLO_SESSION_SECRET must contain at least 24 characters.');
  return [current, process.env.SOLO_SESSION_SECRET_PREVIOUS].filter(Boolean) as string[];
}

export async function seal(value: SecretSoloSession | PhotoAsset) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await encryptionKey(secrets()[0]),
    encoder.encode(JSON.stringify(value)),
  );
  return `${base64Url(iv)}.${base64Url(new Uint8Array(encrypted))}`;
}

export async function unseal<T extends SecretSoloSession | PhotoAsset>(token: string, expectedKind: T['kind']): Promise<T> {
  if (token.length > 50_000) throw new Error('Session token is too large.');
  const [ivValue, encryptedValue, extra] = token.split('.');
  if (!ivValue || !encryptedValue || extra) throw new Error('Malformed session token.');
  for (const secret of secrets()) {
    try {
      const clear = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64Url(ivValue) },
        await encryptionKey(secret),
        fromBase64Url(encryptedValue),
      );
      const value = JSON.parse(decoder.decode(clear)) as T;
      if (value.kind !== expectedKind || value.version !== 1 || Date.parse(value.expiresAt) <= Date.now()) {
        throw new Error('Session token has expired or has the wrong type.');
      }
      return value;
    } catch {
      // Try the previous rotation key before rejecting the token.
    }
  }
  throw new Error('Session token is invalid or expired.');
}

function commitmentObject(session: Pick<SecretSoloSession,
  'sessionId' | 'departureTime' | 'station' | 'spot' | 'panorama' | 'route' | 'salt'>) {
  return {
    sessionId: session.sessionId,
    departureTime: session.departureTime,
    station: session.station,
    spot: session.spot,
    panorama: session.panorama,
    route: session.route,
    salt: session.salt,
  };
}

export async function commitmentFor(session: Parameters<typeof commitmentObject>[0]) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(commitmentObject(session))));
  return base64Url(new Uint8Array(digest));
}

export function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status, headers: { 'cache-control': 'no-store' } });
}

export async function readJson<T>(request: Request): Promise<T> {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > 100_000) throw new Error('Request body is too large.');
  return request.json() as Promise<T>;
}
