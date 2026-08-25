import { SF_BOUNDS } from '../../src/data';
import { solveHiderQuestion } from '../../src/hider';
import { QUESTION_DEFINITIONS } from '../../src/questions';
import { canonicalQuestionKey, cardsForQuestion, distanceMeters, keptCardsForQuestion, keptCardsFromQuestionUses, LEGACY_SOLO_PHOTO_KINDS, publicSoloDisplayText, soloPhotoPlan, SOLO_PHOTO_SUBJECTS, type AnySoloPhotoKind } from '../../src/solo';
import type { Constraint, Position, QuestionKind } from '../../src/types';
import { panoramaAt } from '../_solo-google';
import { jsonError, readJson, seal, unseal, type PhotoAsset, type SecretSoloSession } from '../_solo-session';

export const config = { runtime: 'edge' };

type QuestionBody = { token?: string; constraint?: Constraint };
const kinds = new Set<QuestionKind>(['radar', 'thermometer', 'measuring', 'matching-region', 'tentacle', 'photo-reference', 'endgame-confirmation']);
const photoKinds = new Set<string>([
  ...SOLO_PHOTO_SUBJECTS.map((subject) => subject.id),
  ...LEGACY_SOLO_PHOTO_KINDS,
]);

function validPosition(position?: Position) {
  return !!position && Number.isFinite(position.lat) && Number.isFinite(position.lng) &&
    position.lat >= SF_BOUNDS.south && position.lat <= SF_BOUNDS.north &&
    position.lng >= SF_BOUNDS.west && position.lng <= SF_BOUNDS.east;
}

function validateConstraint(constraint?: Constraint) {
  if (!constraint || !kinds.has(constraint.kind) || !validPosition(constraint.origin)) return false;
  if (constraint.kind === 'thermometer' && !validPosition(constraint.target)) return false;
  if (constraint.name.length > 200 || (constraint.category?.length ?? 0) > 100) return false;
  if (constraint.distanceMiles !== undefined && (!Number.isFinite(constraint.distanceMiles) || constraint.distanceMiles <= 0 || constraint.distanceMiles > 100)) return false;
  if (constraint.kind === 'photo-reference' && !photoKinds.has(constraint.category ?? '')) return false;
  return true;
}

export default async function handler(request: Request) {
  if (request.method !== 'POST') return jsonError('Use POST to ask a Solo question.', 405);
  try {
    const body = await readJson<QuestionBody>(request);
    if (!body.token || !validateConstraint(body.constraint)) return jsonError('The Solo question is incomplete or invalid.');
    const session = await unseal<SecretSoloSession>(body.token, 'solo-session');
    if (session.phase === 'found' || session.phase === 'gave-up') return jsonError('This Solo game has already ended.', 409);
    const constraint = body.constraint!;
    const key = canonicalQuestionKey(constraint);
    const priorUses = session.questionUses[key] ?? 0;
    let cardsDrawn = cardsForQuestion(constraint, priorUses);
    let cardsKept = keptCardsForQuestion(constraint, priorUses);
    let answer = constraint.answer;
    let displayText = '';
    let resolvedRegionId: string | undefined;
    let photoUrl: string | undefined;

    if (constraint.kind === 'photo-reference') {
      const plan = soloPhotoPlan(
        constraint.category as AnySoloPhotoKind,
        session.spot,
        session.station.position,
        constraint.direction,
        session.wideHeading,
      );
      let panorama = plan.source === 'station' ? session.stationPanorama : session.panorama;
      if (plan.unavailableReason) {
        displayText = plan.displayText;
        photoUrl = undefined;
      } else if (plan.source === 'station' && !panorama) {
        const metadata = await panoramaAt(session.station.position);
        if (metadata) {
          panorama = { id: metadata.id, date: metadata.date };
          session.stationPanorama = panorama;
        }
      }
      if (!plan.unavailableReason && panorama) {
        const asset: PhotoAsset = {
          kind: 'solo-photo', version: 1, expiresAt: session.expiresAt,
          panoramaId: panorama.id,
          heading: plan.heading,
          pitch: plan.pitch,
          fov: plan.fov,
        };
        const assetToken = await seal(asset);
        photoUrl = `/api/solo/photo?token=${encodeURIComponent(assetToken)}`;
        displayText = plan.displayText;
      } else if (!plan.unavailableReason) {
        displayText = `I cannot answer: outdoor Street View is unavailable at the ${plan.source === 'station' ? 'central station' : 'hiding location'}`;
      }
      answer = 'yes';
    } else if (constraint.kind === 'endgame-confirmation') {
      const correct = distanceMeters(constraint.origin, session.station.position) <= 0.25 * 1609.344;
      answer = correct ? 'yes' : 'no';
      displayText = correct ? 'Yes — end game has begun' : 'No — that pin is outside the hiding zone';
      cardsDrawn = correct ? 0 : 1;
      cardsKept = 0;
      if (correct) session.phase = 'end-game';
    } else {
      const answerPosition = constraint.kind === 'matching-region' && constraint.category === 'transit-route'
        ? session.station.position
        : session.spot;
      const result = solveHiderQuestion(constraint, answerPosition);
      if (!result.answer) return jsonError(result.displayText, 422);
      answer = result.answer;
      displayText = publicSoloDisplayText(constraint.kind, result.displayText);
      resolvedRegionId = result.resolvedRegionId;
    }

    session.questionUses[key] = priorUses + 1;
    session.cardsDrawn += cardsDrawn;
    session.cardsKept = (session.cardsKept ?? keptCardsFromQuestionUses({ ...session.questionUses, [key]: priorUses })) + cardsKept;
    return Response.json({
      token: await seal(session),
      answer,
      displayText,
      resolvedRegionId,
      photoUrl,
      repetition: priorUses + 1,
      cardsDrawn,
      cardsKept,
      totalCardsDrawn: session.cardsDrawn,
      totalCardsKept: session.cardsKept,
      phase: session.phase,
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'The AI could not answer that question.', 400);
  }
}
