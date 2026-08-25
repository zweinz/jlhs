import { CARD_CATALOG } from '../../src/cards';
import { addDecision, publicCardState, reconcileCardEffects } from '../_solo-cards';
import { jsonError, readJson, seal, unseal, type SecretSoloSession } from '../_solo-session';

export const config = { runtime: 'edge' };

type CardEventBody = {
  token?: string;
  event?:
    | { type: 'accept-pending' | 'reject-pending' | 'clear' | 'complete-task' | 'report-failure'; effectId: string }
    | { type: 'hangman-guess'; effectId: string; guess: string };
};

export default async function handler(request: Request) {
  if (request.method !== 'POST') return jsonError('Use POST for Solo card events.', 405);
  try {
    const body = await readJson<CardEventBody>(request);
    if (!body.token || !body.event || typeof body.event.effectId !== 'string') return jsonError('The card event is incomplete.');
    const session = await unseal<SecretSoloSession>(body.token, 'solo-session');
    reconcileCardEffects(session);
    const effect = session.activeEffects?.find((candidate) => candidate.id === body.event!.effectId);
    if (!effect) return jsonError('That curse is no longer active.', 404);
    let message = '';

    if (body.event.type === 'accept-pending') {
      if (effect.status !== 'pending') return jsonError('That curse is not awaiting confirmation.', 409);
      if (effect.cardId === 'distant-cuisine' && (!effect.proposedPosition || !effect.proposedPanorama)) return jsonError('Distant Cuisine has no validated restaurant location.', 409);
      if (effect.cardId === 'mediocre-travel-agent' && !effect.proposedPosition) return jsonError('Mediocre Travel Agent has no validated destination.', 409);
      if (effect.cardId === 'unguided-tourist' && !effect.imageUrl) return jsonError('Unguided Tourist has no validated Street View scene.', 409);
      effect.status = 'active';
      if (effect.cardId === 'distant-cuisine' && effect.proposedPosition) {
        const previousStationName = session.station.name;
        session.spot = effect.proposedPosition;
        if (effect.proposedPanorama) session.panorama = effect.proposedPanorama;
        session.movementHistory = [...(session.movementHistory ?? []), {
          at: new Date().toISOString(), reason: 'distant-cuisine', station: session.station,
          position: session.spot, previousStationName,
        }];
        session.positionRevision = (session.positionRevision ?? 0) + 1;
      }
      message = `${effect.name} is active. ${effect.completionInstruction}`;
    } else if (body.event.type === 'reject-pending') {
      if (effect.status !== 'pending') return jsonError('That curse is not awaiting confirmation.', 409);
      session.activeEffects = session.activeEffects?.filter((candidate) => candidate.id !== effect.id);
      session.deck.usedPile = session.deck.usedPile.filter((instance) => instance !== effect.cardInstance);
      session.deck.discardPile.push(effect.cardInstance);
      message = `${effect.name} was rejected and discarded. The every-other-question cooldown remains.`;
    } else if (body.event.type === 'clear') {
      if (CARD_CATALOG[effect.cardId].resolution !== 'manual-clear' || effect.status !== 'active') {
        return jsonError(`${effect.name} cannot be cleared manually.`, 409);
      }
      session.activeEffects = session.activeEffects?.filter((candidate) => candidate.id !== effect.id);
      message = `${effect.name} cleared on the seekers’ report.`;
    } else if (body.event.type === 'complete-task') {
      if (CARD_CATALOG[effect.cardId].resolution !== 'task-then-persistent' || effect.status !== 'active') {
        return jsonError('That curse is not awaiting task completion.', 409);
      }
      effect.status = 'monitoring';
      effect.blocksQuestions = false;
      effect.blocksTransit = false;
      message = `${effect.name} task completed. Its carried-item or souvenir condition remains tracked for the rest of the game.`;
    } else if (body.event.type === 'report-failure') {
      if (!effect.failureBonusMinutes) return jsonError('That curse has no failure bonus.', 409);
      if (effect.failureReported) return jsonError('That failure bonus was already awarded.', 409);
      if (CARD_CATALOG[effect.cardId].resolution === 'task-then-persistent' && effect.status !== 'monitoring') {
        return jsonError('Complete the curse task before reporting loss of its tracked item.', 409);
      }
      effect.failureReported = true;
      session.bonusMinutes = (session.bonusMinutes ?? 0) + effect.failureBonusMinutes;
      if (CARD_CATALOG[effect.cardId].resolution === 'task-then-persistent') {
        effect.status = 'failed';
        effect.detail = `${effect.failureInstruction ?? 'The tracked condition failed.'} ${effect.failureBonusMinutes} bonus minutes were awarded.`;
        effect.completionInstruction = 'The failure has been recorded; no further action is required for this curse.';
      }
      message = `${effect.failureBonusMinutes} bonus minutes awarded. ${effect.failureInstruction ?? 'The card-specific failure was reported.'}`;
    } else {
      if (effect.cardId !== 'hidden-hangman' || !effect.hangmanWord) return jsonError('That curse is not a Hangman game.', 409);
      if (!('guess' in body.event)) return jsonError('A Hangman guess is required.');
      if (effect.status === 'waiting') return jsonError('Hangman is in its final required wait and will clear automatically.', 409);
      if (effect.lockedUntil && Date.parse(effect.lockedUntil) > Date.now()) return jsonError(`Hangman cannot be retried until ${effect.lockedUntil}.`, 409);
      effect.lockedUntil = undefined;
      const guess = body.event.guess.trim().toLowerCase();
      if (!/^[a-z]{1,5}$/.test(guess)) return jsonError('Enter one letter or a five-letter word.');
      const word = effect.hangmanWord;
      const priorGuesses = new Set([...(effect.hangmanGuesses ?? []), ...(effect.hangmanWrong ?? [])]);
      if (priorGuesses.has(guess)) return jsonError('That Hangman guess was already submitted.', 409);
      if (guess.length === 1 && word.includes(guess)) effect.hangmanGuesses = [...(effect.hangmanGuesses ?? []), guess];
      if (guess === word || word.split('').every((letter) => effect.hangmanGuesses?.includes(letter))) {
        session.activeEffects = session.activeEffects?.filter((candidate) => candidate.id !== effect.id);
        message = 'Hangman solved. The curse is cleared.';
      } else {
        if (guess.length === 5 || !word.includes(guess)) effect.hangmanWrong = [...(effect.hangmanWrong ?? []), guess];
        if ((effect.hangmanWrong?.length ?? 0) >= 7) {
          effect.hangmanLosses = (effect.hangmanLosses ?? 0) + 1;
          if (effect.hangmanLosses >= 2) {
            effect.status = 'waiting';
            effect.expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
            message = 'The seekers lost twice. Hangman will clear automatically after the final 10-minute wait.';
          } else {
            effect.hangmanWrong = [];
            effect.hangmanGuesses = [];
            effect.lockedUntil = new Date(Date.now() + 10 * 60_000).toISOString();
            message = 'Hangman lost. The next attempt unlocks after 10 minutes.';
          }
        } else message = 'Hangman guess recorded.';
      }
    }
    addDecision(session, message);
    const cardState = publicCardState(session);
    return Response.json({ token: await seal(session), phase: session.phase, message, cardState }, {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Could not apply the card event.', 400);
  }
}
