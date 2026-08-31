import { CARD_CATALOG, cardIdFromInstance } from '../../src/cards';
import { addDecision, publicCardState, reconcileCardEffects } from '../_solo-cards';
import { jsonError, readJson, seal, unseal, type SecretSoloSession } from '../_solo-session';
import { distanceMeters } from '../../src/solo';
import { requireRunningSession, SoloPausedError } from '../_solo-clock';
import { playSoloCards } from '../_solo-play';

export const config = { runtime: 'edge' };

type CardEventBody = {
  token?: string;
  event?:
    | { type: 'accept-pending' | 'reject-pending' | 'clear' | 'complete-task' | 'report-failure'; effectId: string }
    | { type: 'veto-infeasible'; effectId: string; reason: 'not-available' | 'unsafe' | 'closed' | 'other'; note?: string }
    | { type: 'hangman-guess'; effectId: string; guess: string };
};

export default async function handler(request: Request) {
  if (request.method !== 'POST') return jsonError('Use POST for Solo card events.', 405);
  try {
    const body = await readJson<CardEventBody>(request);
    if (!body.token || !body.event || typeof body.event.effectId !== 'string') return jsonError('The card event is incomplete.');
    const session = await unseal<SecretSoloSession>(body.token, 'solo-session');
    requireRunningSession(session);
    reconcileCardEffects(session);
    const effect = session.activeEffects?.find((candidate) => candidate.id === body.event!.effectId);
    if (!effect) return jsonError('That curse is no longer active.', 404);
    let message = '';

    if (body.event.type === 'accept-pending') {
      if (effect.status !== 'pending') return jsonError('That curse is not awaiting confirmation.', 409);
      if (effect.cardId === 'distant-cuisine' && (!effect.placeName || !effect.proposedPosition ||
        !Number.isFinite(effect.proposedPosition.lat) || !Number.isFinite(effect.proposedPosition.lng) ||
        distanceMeters(effect.proposedPosition, session.station.position) > session.stationZoneMiles * 1609.344)) {
        return jsonError('Distant Cuisine needs a validated reference restaurant inside the hiding zone.', 409);
      }
      if (effect.cardId === 'mediocre-travel-agent' && !effect.proposedPosition) return jsonError('Mediocre Travel Agent has no validated destination.', 409);
      if (effect.cardId === 'unguided-tourist' && !effect.imageUrl) return jsonError('Unguided Tourist has no validated Street View scene.', 409);
      effect.status = 'active';
      message = `${effect.name} is active. ${effect.completionInstruction}`;
      if (effect.cardId === 'distant-cuisine') message += ' The restaurant is a reference only; Xeno has not moved.';
    } else if (body.event.type === 'reject-pending') {
      if (effect.status !== 'pending') return jsonError('That curse is not awaiting confirmation.', 409);
      session.activeEffects = session.activeEffects?.filter((candidate) => candidate.id !== effect.id);
      session.deck.usedPile = session.deck.usedPile.filter((instance) => instance !== effect.cardInstance);
      session.deck.discardPile.push(effect.cardInstance);
      message = `${effect.name} was rejected and discarded. ${cardIdFromInstance(effect.cardInstance) === 'duplicate' ? 'Duplicate did not use the normal card allowance.' : 'The every-other-question cooldown remains.'}`;
    } else if (body.event.type === 'veto-infeasible') {
      const resolution = CARD_CATALOG[effect.cardId].resolution;
      if (effect.status !== 'active' || (resolution !== 'manual-clear' && resolution !== 'task-then-persistent')) {
        return jsonError(`${effect.name} cannot be vetoed as infeasible.`, 409);
      }
      if (!['not-available', 'unsafe', 'closed', 'other'].includes(body.event.reason) || (body.event.note?.length ?? 0) > 200) {
        return jsonError('Choose a valid infeasibility reason and keep the note under 200 characters.');
      }
      session.activeEffects = session.activeEffects?.filter((candidate) => candidate.id !== effect.id);
      session.deck.usedPile = session.deck.usedPile.filter((instance) => instance !== effect.cardInstance);
      if (!session.deck.discardPile.includes(effect.cardInstance)) session.deck.discardPile.push(effect.cardInstance);
      if (effect.cardId === 'impressionable-consumer') session.freeNextQuestion = false;
      const reason = body.event.reason === 'not-available' ? 'not available nearby'
        : body.event.reason === 'unsafe' ? 'unsafe or inaccessible'
          : body.event.reason === 'closed' ? 'closed, weather, or missing equipment'
            : body.event.note?.trim() || 'not doable';
      message = `${effect.name} was vetoed by the seekers as ${reason}. No bonus was awarded; ${cardIdFromInstance(effect.cardInstance) === 'duplicate' ? 'Duplicate did not use the normal card allowance' : 'the curse cooldown still counts'}.`;
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
    // Do not immediately re-cast an effect the seekers just rejected or found unsafe.
    const playedCardAnnouncements = ['reject-pending', 'veto-infeasible', 'report-failure'].includes(body.event.type)
      ? [] : await playSoloCards(session, { allowNormal: false });
    if (playedCardAnnouncements.length) message += ` ${playedCardAnnouncements.join(' ')}`;
    const cardState = publicCardState(session);
    return Response.json({ token: await seal(session), phase: session.phase, message, playedCardAnnouncements, cardState }, {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Could not apply the card event.', error instanceof SoloPausedError ? 409 : 400);
  }
}
