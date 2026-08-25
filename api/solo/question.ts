import { SF_BOUNDS } from '../../src/data';
import { solveHiderQuestion } from '../../src/hider';
import { QUESTION_DEFINITIONS } from '../../src/questions';
import { canonicalQuestionKey, cardsForQuestion, keptCardsForQuestion, keptCardsFromQuestionUses, photoCamera, publicSoloDisplayText, SOLO_PHOTO_SUBJECTS, type SoloPhotoKind } from '../../src/solo';
import type { Constraint, Position, QuestionKind } from '../../src/types';
import { jsonError, readJson, seal, unseal, type PhotoAsset, type SecretSoloSession } from '../_solo-session';

export const config = { runtime: 'edge' };

type QuestionBody = { token?: string; constraint?: Constraint };
const kinds = new Set<QuestionKind>(['radar', 'thermometer', 'measuring', 'matching-region', 'tentacle', 'photo-reference']);
const photoKinds = new Set(SOLO_PHOTO_SUBJECTS.map((subject) => subject.id));

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
  if (constraint.kind === 'photo-reference' && !photoKinds.has(constraint.category as SoloPhotoKind)) return false;
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
    const cardsDrawn = cardsForQuestion(constraint, priorUses);
    const cardsKept = keptCardsForQuestion(constraint, priorUses);
    let answer = constraint.answer;
    let displayText: string;
    let resolvedRegionId: string | undefined;
    let photoUrl: string | undefined;

    if (constraint.kind === 'photo-reference') {
      const camera = photoCamera(
        constraint.category as SoloPhotoKind,
        session.spot,
        session.station.position,
        constraint.direction,
        session.wideHeading,
      );
      const asset: PhotoAsset = {
        kind: 'solo-photo', version: 1, expiresAt: session.expiresAt,
        panoramaId: session.panorama.id, ...camera,
      };
      const assetToken = await seal(asset);
      photoUrl = `/api/solo/photo?token=${encodeURIComponent(assetToken)}`;
      displayText = 'Street View photo from the AI’s committed hiding spot';
      answer = 'yes';
    } else {
      const result = solveHiderQuestion(constraint, session.spot);
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
