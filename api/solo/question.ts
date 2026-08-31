import { SF_BOUNDS } from '../../src/data';
import { TENTACLE_CATEGORIES } from '../../src/data';
import { solveHiderQuestion } from '../../src/hider';
import { nearestPoi } from '../../src/geometry';
import { QUESTION_DEFINITIONS, RULEBOOK_DISTANCE_CHOICES } from '../../src/questions';
import { MEASURING_SUBJECTS, SF_MATCHING_SUBJECTS, selectableSubjects } from '../../src/rulebook';
import { canonicalQuestionKey, cardsForQuestion, distanceMeters, keptCardsForQuestion, publicSoloDisplayText, SOLO_PHOTO_SUBJECTS, type AnySoloPhotoKind } from '../../src/solo';
import type { Constraint, Position, QuestionKind } from '../../src/types';
import { jsonError, readJson, seal, unseal, type SecretSoloSession } from '../_solo-session';
import { requireRunningSession, SoloPausedError } from '../_solo-clock';
import { cardIdFromInstance } from '../../src/cards';
import { chooseCardStrategy, chooseResponseStrategy, type GeminiFallbackReason } from '../_solo-gemini';
import { addDecision, advancePersistentEffects, enforceSoloHandLimit, fallbackPlay, legalPostAnswerCards, legalResponseCards, playResponseCard, preferredEarlyPowerupPlay, prepareQuestionReward, publicCardNames, publicCardState, questionIsBlocked, spottyMemoryCategoryLabel } from '../_solo-cards';
import { playSoloCards } from '../_solo-play';
import { resolveSoloPhoto } from '../_solo-photos';

export const config = { runtime: 'edge' };

type QuestionBody = { token?: string; constraint?: Constraint };
const kinds = new Set<QuestionKind>(['radar', 'thermometer', 'measuring', 'matching-region', 'tentacle', 'photo-reference', 'endgame-confirmation']);
const photoKinds = new Set<string>([
  ...SOLO_PHOTO_SUBJECTS.map((subject) => subject.id),
]);
const tentacleKinds = new Set<string>(TENTACLE_CATEGORIES);

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
  if (constraint.kind === 'tentacle' && (!tentacleKinds.has(constraint.category ?? '') || constraint.distanceMiles !== 1)) return false;
  return true;
}

export function randomizeCandidates(constraint: Constraint, session: SecretSoloSession) {
  let values: Constraint[] = [];
  if (constraint.kind === 'radar' || constraint.kind === 'thermometer') {
    values = RULEBOOK_DISTANCE_CHOICES[constraint.kind].filter((distance) => distance !== constraint.distanceMiles).map((distance) => ({
      ...constraint, distanceMiles: distance, name: `${QUESTION_DEFINITIONS[constraint.kind].label} · ${distance} mi`,
    }));
  } else if (constraint.kind === 'measuring') {
    values = selectableSubjects(MEASURING_SUBJECTS).filter((subject) => subject.id !== constraint.category).map((subject) => ({
      ...constraint, category: subject.id, name: `${QUESTION_DEFINITIONS.measuring.label} · ${subject.label}`,
    }));
  } else if (constraint.kind === 'matching-region') {
    values = SF_MATCHING_SUBJECTS
      .filter((subject) => subject.id !== constraint.category && (subject.id !== 'transit-route' || constraint.category === 'transit-route'))
      .map((subject) => ({
        ...constraint,
        category: subject.id,
        regionId: subject.id === 'transit-route' ? constraint.regionId : nearestPoi(subject.id, constraint.origin)?.id,
        name: `${QUESTION_DEFINITIONS['matching-region'].label} · ${subject.label}`,
      }));
  } else if (constraint.kind === 'tentacle') {
    values = TENTACLE_CATEGORIES
      .filter((category) => category !== constraint.category)
      .map((category) => ({
        ...constraint, category, regionId: undefined, distanceMiles: 1,
        name: `${QUESTION_DEFINITIONS.tentacle.label} · ${category.replaceAll('-', ' ')}`,
      }));
  } else if (constraint.kind === 'photo-reference') {
    values = SOLO_PHOTO_SUBJECTS.filter((subject) => subject.id !== constraint.category).map((subject) => ({
      ...constraint, category: subject.id, name: `Photo · ${subject.label}`,
    }));
  }
  const spottyMemoryActive = session.activeEffects?.some((effect) => effect.cardId === 'spotty-memory');
  return values.filter((candidate) => {
    const key = canonicalQuestionKey(candidate);
    return !session.questionUses[key] && !session.blockedQuestionKeys?.includes(key) &&
      !(spottyMemoryActive && session.spottyMemoryCategory === candidate.kind);
  });
}

export default async function handler(request: Request) {
  if (request.method !== 'POST') return jsonError('Use POST to ask a Solo question.', 405);
  try {
    const body = await readJson<QuestionBody>(request);
    if (!body.token || !validateConstraint(body.constraint)) return jsonError('The Solo question is incomplete or invalid.');
    const session = await unseal<SecretSoloSession>(body.token, 'solo-session');
    requireRunningSession(session);
    if (session.phase === 'found' || session.phase === 'gave-up') return jsonError('This Solo game has already ended.', 409);
    let constraint = body.constraint!;
    let key = canonicalQuestionKey(constraint);
    let outcome: 'answered' | 'randomized' = 'answered';
    let replacementConstraint: Constraint | undefined;
    let randomizedFrom: string | undefined;
    let randomizedTo: string | undefined;
    let geminiFallbackReason: GeminiFallbackReason | undefined;
    const geminiFallbackDetails: string[] = [];
    const announcements: string[] = [];
    let normalCardAvailable = true;
    {
      if (questionIsBlocked(session)) return jsonError('Complete or resolve the active blocking curse before asking another question.', 409);
      if (session.blockedQuestionKeys?.includes(key)) return jsonError('Drained Brain has disabled this question for the rest of the run.', 409);
      const spottyMemoryActive = session.activeEffects?.some((effect) => effect.cardId === 'spotty-memory');
      if (spottyMemoryActive && session.spottyMemoryCategory === constraint.kind) {
        return jsonError(`Spotty Memory currently disables ${spottyMemoryCategoryLabel(constraint.kind)} questions. Choose another category.`, 409);
      }
      session.questionNumber = (session.questionNumber ?? 0) + 1;
      session.lastSeekerPosition = constraint.kind === 'thermometer' && constraint.target ? constraint.target : constraint.origin;
      session.lastSeekerQuestionNumber = session.questionNumber;
      session.lastTransitRoute = constraint.kind === 'matching-region' && constraint.category === 'transit-route' ? constraint.regionId : undefined;
      const replacements = randomizeCandidates(constraint, session);
      const responseChoice = await chooseResponseStrategy(session, constraint, legalResponseCards(session), replacements.length);
      geminiFallbackReason = responseChoice.fallbackReason;
      if (responseChoice.fallbackDetail) geminiFallbackDetails.push(responseChoice.fallbackDetail);
      const responseUsesDuplicate = responseChoice.card && cardIdFromInstance(responseChoice.card) === 'duplicate';
      const vetoAnnouncement = `Xeno played Veto question${responseUsesDuplicate ? ' using Duplicate another card' : ''}.`;
      if (responseChoice.action === 'veto' && responseChoice.card && playResponseCard(session, responseChoice.card, 'veto', vetoAnnouncement)) {
        session.xenoVetoes = (session.xenoVetoes ?? 0) + 1;
        session.questionUses[key] = (session.questionUses[key] ?? 0) + 1;
        session.recentQuestions = [...(session.recentQuestions ?? []), { name: constraint.name, answer: 'vetoed', kind: constraint.kind }].slice(-6);
        announcements.push(vetoAnnouncement, ...await playSoloCards(session, {
          selected: responseUsesDuplicate ? preferredEarlyPowerupPlay(session) ?? fallbackPlay(session) : undefined,
          allowNormal: Boolean(responseUsesDuplicate),
        }));
        advancePersistentEffects(session);
        const cardState = publicCardState(session);
        return Response.json({
          token: await seal(session), outcome: 'vetoed', displayText: 'Question vetoed — no answer or card reward.',
          repetition: session.questionUses[key], cardsDrawn: 0, cardsKept: 0,
          totalCardsDrawn: session.cardsDrawn, totalCardsKept: session.cardsKept ?? 0,
          questionUses: session.questionUses, phase: session.phase,
          playedCardAnnouncements: announcements, geminiFallbackReason, geminiFallbackDetails, cardState,
        }, { headers: { 'cache-control': 'no-store' } });
      }
      if (responseChoice.action === 'randomize' && responseChoice.card && replacements.length) {
        const replacement = replacements[crypto.getRandomValues(new Uint32Array(1))[0] % replacements.length];
        const announcement = replacement
          ? `Xeno played Randomize question${responseUsesDuplicate ? ' using Duplicate another card' : ''}: “${constraint.name}” was replaced with “${replacement.name}”.`
          : undefined;
        if (replacement && playResponseCard(session, responseChoice.card, 'randomize', announcement)) {
          normalCardAvailable = Boolean(responseUsesDuplicate);
          session.randomizations = (session.randomizations ?? 0) + 1;
          announcements.push(announcement!);
          randomizedFrom = constraint.name;
          randomizedTo = replacement.name;
          constraint = replacement;
          replacementConstraint = constraint;
          key = canonicalQuestionKey(constraint);
          outcome = 'randomized';
        }
      }
    }
    const priorUses = session.questionUses[key] ?? 0;
    let cardsDrawn = cardsForQuestion(constraint, priorUses);
    let cardsKept = keptCardsForQuestion(constraint, priorUses);
    if (constraint.kind === 'photo-reference' && constraint.category === 'you') {
      cardsDrawn = 0;
      cardsKept = 0;
    }
    let answer = constraint.answer;
    let displayText = '';
    let resolvedRegionId: string | undefined;
    let photoUrl: string | undefined;
    let rewardEligible = true;

    if (constraint.kind === 'photo-reference') {
      try {
        const result = await resolveSoloPhoto(session, constraint.category as AnySoloPhotoKind, constraint.direction);
        displayText = result.displayText;
        photoUrl = result.photoUrl;
        rewardEligible = result.rewardEligible;
      } catch (error) {
        console.warn('[Solo photo unavailable]', error instanceof Error ? error.name : 'unknown');
        displayText = 'I cannot answer: the photo service is temporarily unavailable';
        rewardEligible = false;
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

    if (!rewardEligible) {
      cardsDrawn = 0;
      cardsKept = 0;
    }
    session.questionUses[key] = priorUses + 1;
    {
      const free = session.freeNextQuestion;
      if (free) {
        cardsDrawn = 0;
        cardsKept = 0;
        session.freeNextQuestion = false;
      }
      const baseDraw = priorUses + 1 > 0 ? Math.floor(cardsDrawn / (priorUses + 1)) : cardsDrawn;
      const baseKeep = priorUses + 1 > 0 ? Math.floor(cardsKept / (priorUses + 1)) : cardsKept;
      const groups = prepareQuestionReward(session, baseDraw, baseKeep, priorUses + 1);
      const strategy = await chooseCardStrategy(
        session,
        groups.map((group) => ({ drawn: group.drawn, keep: group.keep })),
        constraint,
        [...(session.recentQuestions ?? []), { name: constraint.name, answer: displayText }],
      );
      geminiFallbackReason ??= strategy.fallbackReason;
      if (strategy.fallbackDetail && !geminiFallbackDetails.includes(strategy.fallbackDetail)) {
        geminiFallbackDetails.push(strategy.fallbackDetail);
      }
      let keptTotal = 0;
      groups.forEach((group, index) => {
        const kept = strategy.keeps[index];
        const discarded = group.drawn.filter((instance) => !kept.includes(instance));
        session.deck.hand.push(...kept);
        session.deck.discardPile.push(...discarded);
        keptTotal += kept.length;
        if (group.drawn.length) {
          const groupLabel = groups.length > 1 ? `, draw group ${index + 1}` : '';
          addDecision(
            session,
            `Question ${session.questionNumber}${groupLabel}: drew ${publicCardNames(group.drawn).join(', ')}; kept ${publicCardNames(kept).join(', ') || 'nothing'}; discarded ${publicCardNames(discarded).join(', ') || 'nothing'}.`,
          );
        }
      });
      const overflowDiscarded = enforceSoloHandLimit(session);
      if (overflowDiscarded.length) addDecision(session, `Question ${session.questionNumber}: discarded ${publicCardNames(overflowDiscarded).join(', ')} for hand overflow.`);
      cardsDrawn = groups.reduce((total, group) => total + group.drawn.length, 0);
      const newlyKept = groups.flatMap((group, index) => strategy.keeps[index]);
      cardsKept = newlyKept.filter((instance) => session.deck.hand.includes(instance)).length;
      const modelSelected = strategy.playCard && legalPostAnswerCards(session).includes(strategy.playCard)
        ? strategy.playCard
        : undefined;
      const selected = modelSelected ?? preferredEarlyPowerupPlay(session) ?? (strategy.source === 'fallback' ? fallbackPlay(session) : undefined);
      announcements.push(...await playSoloCards(session, { selected, allowNormal: normalCardAvailable }));
      session.cardsDrawn += cardsDrawn;
      session.cardsKept = (session.cardsKept ?? 0) + cardsKept;
      session.recentQuestions = [...(session.recentQuestions ?? []), { name: constraint.name, answer: displayText, kind: constraint.kind }].slice(-6);
      advancePersistentEffects(session);
    }
    const cardState = publicCardState(session);
    const answeredConstraintPatch: Partial<Constraint> = {
      name: constraint.name,
      kind: constraint.kind,
      enabled: true,
      answer,
      answerSet: true,
      distanceMiles: constraint.distanceMiles,
      direction: constraint.direction,
      category: constraint.category,
      regionId: resolvedRegionId ?? constraint.regionId,
    };
    return Response.json({
      token: await seal(session),
      answer,
      answeredConstraintPatch,
      displayText,
      resolvedRegionId,
      photoUrl,
      repetition: priorUses + 1,
      cardsDrawn,
      cardsKept,
      totalCardsDrawn: session.cardsDrawn,
      totalCardsKept: session.cardsKept,
      questionUses: session.questionUses,
      phase: session.phase,
      outcome,
      replacementConstraint,
      randomizedFrom,
      randomizedTo,
      playedCardAnnouncements: announcements,
      geminiFallbackReason,
      geminiFallbackDetails,
      cardState,
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Xeno could not answer that question.', error instanceof SoloPausedError ? 409 : 400);
  }
}
