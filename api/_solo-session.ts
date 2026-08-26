import type { Position, TransitScope } from '../src/types';
import type { SoloMapEvidence, SoloPhase } from '../src/solo';
import { normalizeQuestionUses } from '../src/solo';
import type { CardId, CardInstanceId, DeckState } from '../src/cards';

declare const process: { env: Record<string, string | undefined> };

export type SecretSoloSession = {
  kind: 'solo-session';
  version: 2;
  sessionId: string;
  createdAt: string;
  startPosition?: Position;
  expiresAt: string;
  departureTime: string;
  transitScope: TransitScope;
  hidingTimeMinutes: number;
  stationZoneMiles: number;
  phase: SoloPhase;
  cardsDrawn: number;
  cardsKept: number;
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
  deck: DeckState;
  questionNumber: number;
  lastCurseQuestionNumber?: number;
  blockedQuestionKeys?: string[];
  activeEffects?: SoloEffectState[];
  bonusMinutes?: number;
  pausedAt?: string;
  totalPausedSeconds?: number;
  pauseCount?: number;
  endedAt?: string;
  publicEvidence?: SoloMapEvidence[];
  xenoVetoes?: number;
  randomizations?: number;
  movementHistory?: Array<{
    at: string;
    reason: 'initial' | 'move' | 'distant-cuisine';
    station: { id: string; name: string; position: Position };
    position: Position;
    previousStationName?: string;
  }>;
  publicMoves?: Array<{
    at: string;
    oldStation: { id: string; name: string; position: Position };
  }>;
  positionRevision?: number;
  recentDecisions?: string[];
  recentQuestions?: Array<{ name: string; answer: string; kind: string }>;
  gemini?: GeminiUsageState;
  lastSeekerPosition?: Position;
  lastSeekerQuestionNumber?: number;
  lastTransitRoute?: string;
  overflowingQuestionsRemaining?: number;
  freeNextQuestion?: boolean;
  spottyMemoryCategory?: string;
  groundedPlaces?: Array<{ purpose: 'distant-cuisine' | 'mediocre-travel-agent'; center: Position; name: string; position: Position; citationUrl?: string; country?: string }>;
};

export type SoloEffectState = {
  id: string;
  cardId: CardId;
  cardInstance: CardInstanceId;
  name: string;
  description: string;
  status: 'pending' | 'active' | 'monitoring' | 'waiting' | 'failed';
  startedQuestion: number;
  blocksQuestions: boolean;
  blocksTransit: boolean;
  failureBonusMinutes?: number;
  citationUrl?: string;
  placeName?: string;
  proposedPosition?: Position;
  proposedPanorama?: { id: string; date?: string };
  mazeSvg?: string;
  hangmanWord?: string;
  hangmanWrong?: string[];
  hangmanGuesses?: string[];
  hangmanLosses?: number;
  failureReported?: boolean;
  expiresAt?: string;
  lockedUntil?: string;
  castingInstruction?: string;
  completionInstruction: string;
  failureInstruction?: string;
  imageUrl?: string;
  detail?: string;
};

export type GeminiUsageState = {
  calls: number;
  mapsCalls: number;
  inputTokens: number;
  outputTokens: number;
  spentMicros: number;
  reservedMapsMicros: number;
  recentCallTimes: string[];
  fallback: boolean;
  fallbackReason?: 'call-limit' | 'budget';
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

export type StreetOrientationAsset = {
  kind: 'solo-street-orientation';
  version: 1;
  expiresAt: string;
  bearing: number;
};

type SealedAsset = SecretSoloSession | PhotoAsset | StreetOrientationAsset;

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

export async function seal(value: SealedAsset) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await encryptionKey(secrets()[0]),
    encoder.encode(JSON.stringify(value)),
  );
  return `${base64Url(iv)}.${base64Url(new Uint8Array(encrypted))}`;
}

export async function unseal<T extends SealedAsset>(token: string, expectedKind: T['kind']): Promise<T> {
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
      if (expectedKind === 'solo-session' && !(value as SecretSoloSession).transitScope) {
        (value as SecretSoloSession).transitScope = 'all';
      }
      if (expectedKind === 'solo-session') {
        const session = value as SecretSoloSession;
        session.questionUses = normalizeQuestionUses(session.questionUses ?? {});
        session.hidingTimeMinutes = session.hidingTimeMinutes ?? 30;
        session.stationZoneMiles = session.stationZoneMiles ?? 0.25;
      }
      const validVersion = expectedKind === 'solo-session' ? value.version === 2 : value.version === 1;
      const validCurrentSoloShape = expectedKind !== 'solo-session' || (
        ['all', 'primary'].includes((value as SecretSoloSession).transitScope) &&
        Array.isArray((value as SecretSoloSession).activeEffects) &&
        Array.isArray((value as SecretSoloSession).publicMoves) &&
        Array.isArray((value as SecretSoloSession).deck?.drawPile) &&
        Array.isArray((value as SecretSoloSession).deck?.hand) &&
        Number.isInteger((value as SecretSoloSession).questionNumber)
      );
      if (value.kind !== expectedKind || !validVersion || !validCurrentSoloShape || Date.parse(value.expiresAt) <= Date.now()) {
        throw new Error('Session token has expired or has the wrong type.');
      }
      return value;
    } catch {
      // Try the previous rotation key before rejecting the token.
    }
  }
  throw new Error('Session token is invalid or expired.');
}

export function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status, headers: { 'cache-control': 'no-store' } });
}

export async function readJson<T>(request: Request): Promise<T> {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > 100_000) throw new Error('Request body is too large.');
  return request.json() as Promise<T>;
}
