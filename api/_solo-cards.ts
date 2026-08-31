import {
  CARD_CATALOG,
  cardForInstance,
  cardIdFromInstance,
  createDeck,
  enforceHandLimit,
  fallbackCardRank,
  handTimeBonusMinutes,
  type CardDefinition,
  type CardId,
  type CardInstanceId,
  type DeckState,
} from '../src/cards';
import type { SoloPublicCardState } from '../src/solo';
import type { TransitScope } from '../src/types';
import type { SecretSoloSession, SoloEffectState } from './_solo-session';
import { chooseSoloHidingLocation } from './_solo-location';
import { deterministicMazeSvg } from './_solo-maze';
export { SOLO_MAZE_SIZE, deterministicMazeSvg } from './_solo-maze';

declare const process: { env: Record<string, string | undefined> };

export const GEMINI_CALL_LIMIT = 40;
export const MAPS_CALL_LIMIT = 2;
export const MOVE_QUESTION_THRESHOLD = 8;

/** The sealed session lacks the full seekers' map; use search progress as a proxy. */
export function moveTiming(session: SecretSoloSession) {
  const questionsSinceRelocation = Math.max(0, session.questionNumber - (session.lastRelocationQuestionNumber ?? 0));
  return {
    basis: 'question-count' as const,
    threshold: MOVE_QUESTION_THRESHOLD,
    questionsSinceRelocation,
    ready: session.phase === 'seeking' && !session.pausedAt && questionsSinceRelocation >= MOVE_QUESTION_THRESHOLD,
  };
}

export function preferredMovePlay(session: SecretSoloSession) {
  if (!moveTiming(session).ready) return undefined;
  return session.deck.hand.find((instance) => cardIdFromInstance(instance) === 'move');
}

export const SPOTTY_MEMORY_CATEGORIES = ['radar', 'thermometer', 'measuring', 'matching-region', 'photo-reference', 'tentacle'] as const;

const SPOTTY_MEMORY_LABELS: Record<(typeof SPOTTY_MEMORY_CATEGORIES)[number], string> = {
  radar: 'Radar',
  thermometer: 'Thermometer',
  measuring: 'Measuring',
  'matching-region': 'Matching',
  'photo-reference': 'Photo',
  tentacle: 'Tentacle',
};

export function spottyMemoryCategoryLabel(category?: string) {
  return category && category in SPOTTY_MEMORY_LABELS
    ? SPOTTY_MEMORY_LABELS[category as keyof typeof SPOTTY_MEMORY_LABELS]
    : undefined;
}

function rollSpottyMemoryCategory() {
  return SPOTTY_MEMORY_CATEGORIES[crypto.getRandomValues(new Uint8Array(1))[0] % SPOTTY_MEMORY_CATEGORIES.length];
}

function cryptoRandom() {
  const value = crypto.getRandomValues(new Uint32Array(1))[0];
  return value / 0x1_0000_0000;
}

function positionDistanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(value));
}

export function initializeCardSession(session: Omit<SecretSoloSession, 'deck' | 'questionNumber'>): SecretSoloSession {
  return {
    ...session,
    version: 2,
    deck: createDeck(cryptoRandom),
    questionNumber: 0,
    lastRelocationQuestionNumber: 0,
    activeEffects: [],
    blockedQuestionKeys: [],
    bonusMinutes: 0,
    totalPausedSeconds: 0,
    pauseCount: 0,
    publicEvidence: [],
    recentDecisions: [],
    publicMoves: [],
    positionRevision: 0,
    gemini: {
      calls: 0, mapsCalls: 0, inputTokens: 0, outputTokens: 0,
      spentMicros: 0, reservedMapsMicros: 0, recentCallTimes: [], fallback: false,
    },
    movementHistory: [{
      at: session.createdAt,
      reason: 'initial',
      station: session.station,
      position: session.spot,
    }],
  };
}

function formatQuestionKey(key: string) {
  const [kind, value] = key.split(':');
  const label = spottyMemoryCategoryLabel(kind) ?? kind;
  if ((kind === 'radar' || kind === 'thermometer') && Number.isFinite(Number(value))) return `${label} · ${Number(value)} mi`;
  return `${label} · ${value?.replaceAll('-', ' ') ?? 'question'}`;
}

export function reconcileCardEffects(session: SecretSoloSession) {
  const now = session.pausedAt ? Date.parse(session.pausedAt) : Date.now();
  session.activeEffects = (session.activeEffects ?? []).filter((effect) => !effect.expiresAt || Date.parse(effect.expiresAt) > now);
  if (!session.activeEffects.some((effect) => effect.cardId === 'spotty-memory')) session.spottyMemoryCategory = undefined;
  if (!session.activeEffects.some((effect) => effect.cardId === 'overflowing-chalice')) session.overflowingQuestionsRemaining = undefined;
}

export function publicCardState(session: SecretSoloSession): SoloPublicCardState {
  reconcileCardEffects(session);
  const effects = (session.activeEffects ?? []).map((effect) => ({
    id: effect.id,
    cardId: effect.cardId,
    name: effect.name,
    description: effect.description,
    status: effect.status,
    blocksQuestions: effect.blocksQuestions,
    blocksTransit: effect.blocksTransit,
    failureBonusMinutes: effect.failureBonusMinutes,
    citationUrl: effect.citationUrl,
    placeName: effect.placeName,
    placePosition: effect.proposedPosition,
    mazeSvg: effect.cardId === 'labyrinth' && effect.mazeSeed ? deterministicMazeSvg(effect.mazeSeed) : effect.mazeSvg,
    hangmanPattern: effect.hangmanWord
      ? effect.hangmanWord.split('').map((letter) => effect.hangmanGuesses?.includes(letter) ? letter : '_').join(' ')
      : undefined,
    hangmanWrong: effect.hangmanWrong,
    failureReported: effect.failureReported,
    expiresAt: effect.expiresAt,
    lockedUntil: effect.lockedUntil,
    castingInstruction: effect.castingInstruction,
    completionInstruction: effect.completionInstruction,
    failureInstruction: effect.failureInstruction,
    imageUrl: effect.imageUrl,
    detail: effect.detail,
    currentRestriction: effect.cardId === 'spotty-memory'
      ? `Currently disabled: ${spottyMemoryCategoryLabel(session.spottyMemoryCategory) ?? 'selecting a category'}`
      : effect.cardId === 'drained-brain'
        ? `Disabled for the rest of the game: ${(session.blockedQuestionKeys ?? []).map(formatQuestionKey).join('; ')}`
        : effect.cardId === 'overflowing-chalice'
          ? `${session.overflowingQuestionsRemaining ?? 0} rewarded question${session.overflowingQuestionsRemaining === 1 ? '' : 's'} remaining.`
          : effect.cardId === 'urban-explorer'
            ? 'Questions are forbidden while on transit or inside a transit station.'
            : undefined,
    disabledQuestionKeys: effect.cardId === 'drained-brain' ? session.blockedQuestionKeys ?? [] : undefined,
    disabledCategory: effect.cardId === 'spotty-memory' ? session.spottyMemoryCategory : undefined,
    canClear: CARD_CATALOG[effect.cardId].resolution === 'manual-clear' && effect.status === 'active',
    canCompleteTask: CARD_CATALOG[effect.cardId].resolution === 'task-then-persistent' && effect.status === 'active',
    canReportFailure: Boolean(effect.failureBonusMinutes && !effect.failureReported &&
      (CARD_CATALOG[effect.cardId].resolution !== 'task-then-persistent' || effect.status === 'monitoring')),
    canVetoInfeasible: effect.status === 'active' &&
      (CARD_CATALOG[effect.cardId].resolution === 'manual-clear' || CARD_CATALOG[effect.cardId].resolution === 'task-then-persistent'),
  }));
  const handCards = [...session.deck.hand.reduce((grouped, instance) => {
    const card = cardForInstance(instance);
    const current = grouped.get(card.id);
    grouped.set(card.id, current
      ? { ...current, count: current.count + 1 }
      : { id: card.id, kind: card.kind, name: card.name, description: card.description, count: 1 });
    return grouped;
  }, new Map<string, NonNullable<SoloPublicCardState['handCards']>[number]>()).values()];
  const persistentFallback = (session.gemini?.fallbackReason === 'call-limit' || session.gemini?.fallbackReason === 'budget')
    && (session.gemini?.fallback ?? false);
  return {
    handCount: session.deck.hand.length,
    maxHandSize: session.deck.maxHandSize,
    handCards,
    deckCount: session.deck.drawPile.length,
    discardCount: session.deck.discardPile.length,
    usedCount: session.deck.usedPile.length,
    activeCurses: effects,
    playHistory: (session.recentDecisions ?? []).filter((decision) =>
      !decision.startsWith('[private] ') &&
      !/Xeno played (?:Duplicate another card as )?Discard [12], draw [23]\./i.test(decision),
    ).slice(-20),
    moves: session.publicMoves ?? [],
    positionRevision: session.positionRevision ?? 0,
    questionBlocked: effects.some((effect) => effect.blocksQuestions),
    nextQuestionFree: Boolean(session.freeNextQuestion),
    nextRewardExtraDraw: (session.overflowingQuestionsRemaining ?? 0) > 0 ? 1 : 0,
    strategy: {
      calls: session.gemini?.calls ?? 0,
      limit: GEMINI_CALL_LIMIT,
      mapsCalls: session.gemini?.mapsCalls ?? 0,
      mapsLimit: MAPS_CALL_LIMIT,
      fallback: persistentFallback,
      fallbackReason: persistentFallback ? session.gemini?.fallbackReason : undefined,
      available: Boolean(process.env.GEMINI_API_KEY) && !persistentFallback,
    },
    bonusMinutes: session.bonusMinutes ?? 0,
    evidence: session.publicEvidence ?? [],
  };
}

export function addDecision(session: SecretSoloSession, decision: string) {
  session.recentDecisions = [...(session.recentDecisions ?? []), decision].slice(-20);
}

export function questionIsBlocked(session: SecretSoloSession) {
  reconcileCardEffects(session);
  return (session.activeEffects ?? []).some((effect) => effect.blocksQuestions);
}

export function advancePersistentEffects(session: SecretSoloSession) {
  const effect = (session.activeEffects ?? []).find((candidate) => candidate.cardId === 'spotty-memory');
  if (!effect || effect.startedQuestion >= (session.questionNumber ?? 0)) return;
  session.spottyMemoryCategory = rollSpottyMemoryCategory();
  addDecision(session, `Spotty Memory now disables ${spottyMemoryCategoryLabel(session.spottyMemoryCategory)} questions.`);
}

export function prepareQuestionReward(session: SecretSoloSession, draw: number, keep: number, repetitions: number) {
  if (repetitions <= 0) return [];
  const groups: Array<{ drawn: CardInstanceId[]; keep: number }> = [];
  const rewardsCards = draw > 0;
  for (let index = 0; index < repetitions; index += 1) {
    const chalice = rewardsCards && index === 0 && (session.overflowingQuestionsRemaining ?? 0) > 0 ? 1 : 0;
    groups.push({ drawn: session.deck.drawPile.splice(0, draw + chalice), keep: Math.min(keep, draw + chalice) });
  }
  if (rewardsCards && (session.overflowingQuestionsRemaining ?? 0) > 0) {
    session.overflowingQuestionsRemaining!--;
    if (session.overflowingQuestionsRemaining === 0) {
      session.activeEffects = session.activeEffects?.filter((effect) => effect.cardId !== 'overflowing-chalice');
      session.overflowingQuestionsRemaining = undefined;
    }
  }
  return groups;
}

export function enforceSoloHandLimit(session: SecretSoloSession) {
  return enforceHandLimit(session.deck);
}

function eligibleDiscard(deck: DeckState, castingCard: CardInstanceId, kind?: 'time-bonus' | 'powerup' | 'curse') {
  return deck.hand
    .filter((instance) => instance !== castingCard && (!kind || cardForInstance(instance).kind === kind))
    .sort((a, b) => fallbackCardRank(a) - fallbackCardRank(b));
}

function canPayCastingCostForCard(deck: DeckState, instance: CardInstanceId, card: CardDefinition) {
  if (card.id === 'drained-brain') return true;
  return eligibleDiscard(deck, instance, card.discardKind).length >= (card.discardCost ?? 0);
}

export function canPayCastingCost(deck: DeckState, instance: CardInstanceId) {
  return canPayCastingCostForCard(deck, instance, cardForInstance(instance));
}

function payCastingCost(deck: DeckState, instance: CardInstanceId, card: CardDefinition) {
  if (card.id === 'drained-brain') {
    const discarded = deck.hand.filter((candidate) => candidate !== instance);
    deck.hand = deck.hand.filter((candidate) => candidate === instance);
    deck.discardPile.push(...discarded);
    return discarded;
  }
  const discarded = eligibleDiscard(deck, instance, card.discardKind).slice(0, card.discardCost ?? 0);
  deck.hand = deck.hand.filter((candidate) => !discarded.includes(candidate));
  deck.discardPile.push(...discarded);
  return discarded;
}

function consume(deck: DeckState, instance: CardInstanceId) {
  deck.hand = deck.hand.filter((candidate) => candidate !== instance);
  deck.usedPile.push(instance);
}

export function curseCadenceAllows(session: SecretSoloSession) {
  const question = session.questionNumber ?? 0;
  return question > 0 && (session.lastCurseQuestionNumber === undefined || question >= session.lastCurseQuestionNumber + 2);
}

export function legalResponseCards(session: SecretSoloSession) {
  const direct = session.deck.hand.filter((instance) => {
    const id = cardIdFromInstance(instance);
    return id === 'veto' || id === 'randomize';
  });
  if (direct.length && session.deck.hand.some((instance) => cardIdFromInstance(instance) === 'duplicate')) {
    direct.push(...session.deck.hand.filter((instance) => cardIdFromInstance(instance) === 'duplicate'));
  }
  return direct;
}

export function responseCardCanActAs(session: SecretSoloSession, instance: CardInstanceId, action: 'veto' | 'randomize') {
  const id = cardIdFromInstance(instance);
  return id === action || (id === 'duplicate' && session.deck.hand.some((candidate) => cardIdFromInstance(candidate) === action));
}

export function preferredResponseCard(session: SecretSoloSession, cards: CardInstanceId[], action: 'veto' | 'randomize') {
  const options = cards.filter((instance) => session.deck.hand.includes(instance) && responseCardCanActAs(session, instance, action));
  const original = options.find((instance) => cardIdFromInstance(instance) === action);
  if (original && session.phase === 'end-game' && session.deck.hand.some((instance) =>
    cardForInstance(instance).kind === 'time-bonus' && (cardForInstance(instance).smallMinutes ?? 0) >= 8)) return original;
  // Spend the copy first so the original remains a target for any other Duplicate.
  return options.find((instance) => cardIdFromInstance(instance) === 'duplicate') ?? options[0];
}

export function playResponseCard(session: SecretSoloSession, instance: CardInstanceId, action: 'veto' | 'randomize', announcement?: string) {
  if (!legalResponseCards(session).includes(instance) || !responseCardCanActAs(session, instance, action)) return false;
  const duplicateNote = cardIdFromInstance(instance) === 'duplicate' ? `Duplicate another card as ${CARD_CATALOG[action].name}` : CARD_CATALOG[action].name;
  consume(session.deck, instance);
  addDecision(session, announcement ?? `Xeno played ${duplicateNote}.`);
  return true;
}

function legalDirectPostAnswerCards(session: SecretSoloSession, copying = false) {
  reconcileCardEffects(session);
  const blockingCurse = (session.activeEffects ?? []).some((effect) => effect.blocksQuestions || effect.blocksTransit);
  return session.deck.hand.filter((instance) => {
    const card = cardForInstance(instance);
    if (card.kind === 'time-bonus' || card.id === 'veto' || card.id === 'randomize' || card.id === 'duplicate') return false;
    if (card.id === 'discard-1-draw-2' && session.deck.hand.length < 2) return false;
    if (card.id === 'discard-2-draw-3' && session.deck.hand.length < 3) return false;
    if (!card.aiPlayable || !canPayCastingCost(session.deck, instance)) return false;
    if (session.phase === 'end-game' && card.endgameAllowed === false) return false;
    if (card.kind === 'curse') {
      // A copy of an already-active persistent restriction adds no new obstacle.
      if (session.activeEffects?.some((effect) => effect.cardId === card.id)) return false;
      if (!copying && !curseCadenceAllows(session)) return false;
      if (blockingCurse && (card.blocksQuestions || card.blocksTransit)) return false;
      if (card.id === 'bridge-troll' && (!session.lastSeekerPosition || positionDistanceMeters(session.lastSeekerPosition, session.spot) < 5 * 1609.344)) return false;
      if ((card.id === 'u-turn' || card.id === 'mediocre-travel-agent') &&
        (!session.lastSeekerPosition || (session.questionNumber ?? 0) - (session.lastSeekerQuestionNumber ?? 0) > 0)) return false;
      if (card.id === 'u-turn' && !session.lastTransitRoute) return false;
      if (card.id === 'mediocre-travel-agent' && session.lastTransitRoute) return false;
    }
    // This AI timing policy applies to both Move and a Duplicate copying Move.
    return card.id !== 'move' || moveTiming(session).ready;
  });
}

export function duplicatePostAnswerTarget(session: SecretSoloSession, duplicate: CardInstanceId) {
  if (cardIdFromInstance(duplicate) !== 'duplicate') return undefined;
  return legalDirectPostAnswerCards(session, true)
    .filter((instance) => instance !== duplicate && canPayCastingCostForCard(session.deck, duplicate, cardForInstance(instance)))
    .sort((a, b) => fallbackCardRank(b) - fallbackCardRank(a))[0];
}

export function preferredPostAnswerCard(session: SecretSoloSession, instance: CardInstanceId) {
  const card = cardForInstance(instance);
  // These discard the whole hand anyway; copying them cannot preserve the original.
  if (card.id === 'duplicate' || card.id === 'move' || card.id === 'drained-brain') return instance;
  const reserveRank = Math.max(0, ...session.deck.hand
    .filter((candidate) => {
      const held = cardForInstance(candidate);
      return held.kind === 'time-bonus' || held.id === 'veto' || held.id === 'randomize';
    }).map(fallbackCardRank));
  // Keep the copy for a stronger response card or premium round-end bonus.
  if (reserveRank > fallbackCardRank(instance)) return instance;
  return session.deck.hand.find((candidate) => cardIdFromInstance(candidate) === 'duplicate' &&
    duplicatePostAnswerTarget(session, candidate) === instance) ?? instance;
}

/** Free copies are considered even after the normal question play is spent. */
export function preferredDuplicatePlay(session: SecretSoloSession) {
  return session.deck.hand
    .filter((instance) => cardIdFromInstance(instance) === 'duplicate')
    .find((instance) => {
      const target = duplicatePostAnswerTarget(session, instance);
      if (!target) return false;
      const card = cardForInstance(target);
      // Avoid speculative casting or discarding the whole hand just to use a copy.
      if (card.uncertainCasting || card.id === 'move' || card.id === 'drained-brain') return false;
      return preferredPostAnswerCard(session, target) === instance;
    });
}

export function effectiveCardIdForPlay(session: SecretSoloSession, instance: CardInstanceId): CardId {
  const target = duplicatePostAnswerTarget(session, instance);
  return target ? cardIdFromInstance(target) : cardIdFromInstance(instance);
}

export function legalPostAnswerCards(session: SecretSoloSession) {
  const direct = legalDirectPostAnswerCards(session);
  const duplicates = session.deck.hand.filter((instance) => cardIdFromInstance(instance) === 'duplicate' && duplicatePostAnswerTarget(session, instance));
  return [...direct, ...duplicates];
}

const HANGMAN_WORDS = ['apple', 'beach', 'brick', 'cabin', 'cloud', 'dance', 'flame', 'grape', 'hotel', 'lemon', 'maple', 'ocean', 'piano', 'river', 'stone', 'tiger', 'train', 'water'];

function hangmanWord(session: SecretSoloSession) {
  const seed = [...session.sessionId].reduce((total, character) => total + character.charCodeAt(0), 0) + (session.questionNumber ?? 0);
  return HANGMAN_WORDS[seed % HANGMAN_WORDS.length];
}


function randomizedSoloCurseDetail(cardId: CardId, random: () => number) {
  const choose = <T,>(options: T[]) => options[Math.min(options.length - 1, Math.max(0, Math.floor(random() * options.length)))];
  if (cardId === 'luxury-car') {
    const threshold = choose([30_000, 35_000, 40_000, 45_000]);
    return `Solo challenge: photograph a car whose typical original US MSRP is at least $${threshold.toLocaleString('en-US')}.`;
  }
  if (cardId === 'bird-guide') {
    const seconds = choose([5, 10, 15]);
    return `Solo challenge: continuously film one wild bird for at least ${seconds} seconds.`;
  }
  if (cardId === 'zoologist') {
    const category = choose(['bird', 'mammal', 'bug']);
    return `Solo challenge: photograph a wild ${category}.`;
  }
  return undefined;
}

function createCurseEffect(session: SecretSoloSession, instance: CardInstanceId, card: CardDefinition, random: () => number): SoloEffectState {
  const durationMinutes = card.smallDurationMinutes;
  return {
    id: crypto.randomUUID(),
    cardId: card.id,
    cardInstance: instance,
    name: card.name,
    description: card.description,
    status: card.uncertainCasting ? 'pending' : 'active',
    startedQuestion: session.questionNumber ?? 0,
    blocksQuestions: Boolean(card.blocksQuestions),
    blocksTransit: Boolean(card.blocksTransit),
    failureBonusMinutes: card.failureBonusMinutes,
    castingInstruction: card.castingInstruction,
    completionInstruction: card.completionInstruction,
    failureInstruction: card.failureInstruction,
    detail: randomizedSoloCurseDetail(card.id, random),
    mazeSeed: card.id === 'labyrinth' ? `${session.sessionId}:${session.questionNumber}` : undefined,
    hangmanWord: card.id === 'hidden-hangman' ? hangmanWord(session) : undefined,
    hangmanWrong: card.id === 'hidden-hangman' ? [] : undefined,
    hangmanGuesses: card.id === 'hidden-hangman' ? [] : undefined,
    hangmanLosses: card.id === 'hidden-hangman' ? 0 : undefined,
    expiresAt: durationMinutes ? new Date(Date.now() + durationMinutes * 60_000).toISOString() : undefined,
  };
}

export type PlayResult = { played: boolean; announcement?: string; pending?: boolean; noEffect?: boolean };

export async function playMoveCard(
  session: SecretSoloSession,
  instance: CardInstanceId,
  chooseLocation: (
    origin: { lat: number; lng: number }, departureTime: string, maxDurationSeconds?: number,
    transitScope?: TransitScope, stationZoneMiles?: number,
  ) => Promise<{
    station: { id: string; name: string; lat: number; lng: number };
    route: SecretSoloSession['route'];
    panorama: { id: string; date?: string; position: { lat: number; lng: number } };
    stationPanorama: { id: string; date?: string; position: { lat: number; lng: number } };
  } | undefined> = chooseSoloHidingLocation,
): Promise<PlayResult> {
  if (effectiveCardIdForPlay(session, instance) !== 'move' || !legalPostAnswerCards(session).includes(instance)) return { played: false };
  const copied = cardIdFromInstance(instance) === 'duplicate';
  const oldStation = session.station;
  const movedAt = new Date();
  const departure = new Date(movedAt.getTime() + 60_000).toISOString();
  const chosen = await chooseLocation(session.spot, departure, 10 * 60, session.transitScope, session.stationZoneMiles);
  if (!chosen) return { played: false };
  consume(session.deck, instance);
  const discarded = [...session.deck.hand];
  session.deck.hand = [];
  session.deck.discardPile.push(...discarded);
  session.station = { id: chosen.station.id, name: chosen.station.name, position: { lat: chosen.station.lat, lng: chosen.station.lng } };
  session.spot = chosen.panorama.position;
  session.panorama = { id: chosen.panorama.id, date: chosen.panorama.date };
  session.stationPanorama = { id: chosen.stationPanorama.id, date: chosen.stationPanorama.date };
  session.route = chosen.route;
  session.positionRevision = (session.positionRevision ?? 0) + 1;
  session.lastRelocationQuestionNumber = session.questionNumber;
  session.publicMoves = [...(session.publicMoves ?? []), {
    at: movedAt.toISOString(), oldStation,
  }];
  session.movementHistory = [...(session.movementHistory ?? []), {
    at: movedAt.toISOString(), reason: 'move', station: session.station,
    position: session.spot, previousStationName: oldStation.name,
  }];
  const discardedNames = publicCardNames(discarded).join(', ') || 'nothing';
  const announcement = `Xeno played ${copied ? 'Duplicate another card as ' : ''}Move. Old station revealed: ${oldStation.name}. Xeno relocated immediately; seekers may continue playing.`;
  addDecision(session, `${announcement} Discarded ${discardedNames}.`);
  return { played: true, announcement };
}

export function playPostAnswerCard(session: SecretSoloSession, instance: CardInstanceId, random = cryptoRandom): PlayResult {
  if (!legalPostAnswerCards(session).includes(instance)) return { played: false };
  const sourceCard = cardForInstance(instance);
  const copiedTarget = sourceCard.id === 'duplicate' ? duplicatePostAnswerTarget(session, instance) : undefined;
  const card = copiedTarget ? cardForInstance(copiedTarget) : sourceCard;
  const copiedNote = copiedTarget ? `Duplicate another card as ${card.name}` : card.name;
  const castingDiscarded = payCastingCost(session.deck, instance, card);
  consume(session.deck, instance);
  const castingNote = castingDiscarded.length ? ` Discarded ${publicCardNames(castingDiscarded).join(', ')} to pay the casting cost.` : '';

  if (card.kind === 'powerup') {
    const privateHandManagement = card.id === 'discard-1-draw-2' || card.id === 'discard-2-draw-3';
    let detail = '';
    if (card.id === 'expand-hand') {
      session.deck.maxHandSize += 1;
      const drawn = session.deck.drawPile.splice(0, 1);
      session.deck.hand.push(...drawn);
      const overflow = enforceHandLimit(session.deck);
      detail = ` Drew ${publicCardNames(drawn).join(', ') || 'nothing'} and expanded the hand limit to ${session.deck.maxHandSize}.`;
      if (overflow.length) detail += ` Discarded ${publicCardNames(overflow).join(', ')} for hand overflow.`;
    } else if (card.id === 'discard-1-draw-2' || card.id === 'discard-2-draw-3') {
      const cost = card.id === 'discard-1-draw-2' ? 1 : 2;
      const discarded = [...session.deck.hand].sort((a, b) => fallbackCardRank(a) - fallbackCardRank(b)).slice(0, cost);
      session.deck.hand = session.deck.hand.filter((candidate) => !discarded.includes(candidate));
      session.deck.discardPile.push(...discarded);
      const drawn = session.deck.drawPile.splice(0, cost + 1);
      session.deck.hand.push(...drawn);
      const overflow = enforceHandLimit(session.deck);
      detail = ` Discarded ${publicCardNames(discarded).join(', ') || 'nothing'} and drew ${publicCardNames(drawn).join(', ') || 'nothing'}.`;
      if (overflow.length) detail += ` Discarded ${publicCardNames(overflow).join(', ')} for hand overflow.`;
    }
    const announcement = `Xeno played ${copiedNote}.`;
    addDecision(session, `${privateHandManagement ? '[private] ' : ''}${announcement}${detail}${castingNote}`);
    return { played: true, announcement: privateHandManagement ? undefined : announcement };
  }

  if (!copiedTarget) session.lastCurseQuestionNumber = session.questionNumber;
  let castingRoll: number | undefined;
  if (card.id === 'endless-tumble' || card.id === 'gamblers-feet') {
    castingRoll = 1 + Math.floor(random() * 6);
    const misses = card.id === 'endless-tumble' ? castingRoll >= 5 : castingRoll % 2 === 0;
    if (misses) {
      const announcement = `Xeno attempted ${copiedNote}, rolled ${castingRoll}, and the curse had no effect.`;
      addDecision(session, `${announcement}${castingNote}`);
      return { played: true, announcement, noEffect: true };
    }
  }
  if (card.id === 'drained-brain') {
    const defaults = ['radar:0.250', 'thermometer:0.500', 'measuring:rail-station', 'matching-region:station-name-length', 'photo-reference:a-tree', 'tentacle:museum'];
    const unasked = defaults.filter((candidate) => !session.questionUses[candidate]);
    const candidates = [...unasked, ...defaults];
    session.blockedQuestionKeys = candidates.filter((candidate, index, all) => all.indexOf(candidate) === index).slice(0, 3);
  }
  if (card.id === 'overflowing-chalice') session.overflowingQuestionsRemaining = 3;
  if (card.id === 'impressionable-consumer') session.freeNextQuestion = true;
  if (card.id === 'spotty-memory') session.spottyMemoryCategory = rollSpottyMemoryCategory();
  const effect = createCurseEffect(session, instance, card, random);
  if (castingRoll !== undefined) effect.detail = `Hider casting roll: ${castingRoll}. The curse took effect.`;
  if (card.id === 'drained-brain') effect.detail = `Disabled questions: ${(session.blockedQuestionKeys ?? []).map(formatQuestionKey).join('; ')}.`;
  session.activeEffects = [...(session.activeEffects ?? []), effect];
  const spottyMemoryNote = card.id === 'spotty-memory'
    ? ` ${spottyMemoryCategoryLabel(session.spottyMemoryCategory)} questions are disabled until the next completed question.`
    : '';
  const announcement = effect.status === 'pending'
    ? `Xeno attempted ${copiedNote}. Casting condition: ${card.castingInstruction ?? 'confirm the printed condition'}.`
    : `Xeno played ${copiedNote}.${spottyMemoryNote}${effect.detail ? ` ${effect.detail}` : ''}`;
  addDecision(session, `${announcement}${castingNote}`);
  return { played: true, announcement, pending: effect.status === 'pending' };
}

export function fallbackKeep(drawn: CardInstanceId[], keep: number, _questionNumber = 0) {
  return [...drawn].sort((a, b) => fallbackCardRank(b) - fallbackCardRank(a)).slice(0, keep);
}

const strategicKeepIds = new Set<CardId>(['veto', 'randomize', 'move']);

export function enforceKeepPriorities(drawn: CardInstanceId[], requested: CardInstanceId[], keep: number) {
  const slots = Math.min(keep, drawn.length);
  const premium = [...drawn]
    .filter((instance) => cardForInstance(instance).kind === 'time-bonus' && (cardForInstance(instance).smallMinutes ?? 0) >= 8)
    .sort((a, b) => fallbackCardRank(b) - fallbackCardRank(a));
  const strategic = drawn
    .filter((instance) => strategicKeepIds.has(cardIdFromInstance(instance)))
    .sort((a, b) => fallbackCardRank(b) - fallbackCardRank(a));
  const required = [...strategic, ...premium].slice(0, slots);
  const chosen = [...required];
  for (const instance of requested) {
    if (chosen.length >= slots) break;
    if (drawn.includes(instance) && !chosen.includes(instance)) chosen.push(instance);
  }
  for (const instance of fallbackKeep(drawn, slots)) {
    if (chosen.length >= slots) break;
    if (!chosen.includes(instance)) chosen.push(instance);
  }
  // Model discretion must not turn a small bonus into a higher priority than
  // useful power-ups/curses. Keep the stronger bonus when no useful alternative exists.
  for (let index = 0; index < chosen.length; index += 1) {
    const card = cardForInstance(chosen[index]);
    if (card.kind !== 'time-bonus' || (card.smallMinutes ?? 0) > 6) continue;
    const replacement = fallbackKeep(drawn, drawn.length).find((instance) =>
      !chosen.includes(instance) &&
      fallbackCardRank(instance) > fallbackCardRank(chosen[index]));
    if (replacement) chosen[index] = replacement;
  }
  return chosen;
}

export function fallbackPlay(session: SecretSoloSession) {
  const options = legalDirectPostAnswerCards(session).sort((a, b) => fallbackCardRank(b) - fallbackCardRank(a));
  const immediatelyUseful = options.find((instance) => {
    const card = cardForInstance(instance);
    if (card.id === 'drained-brain') {
      const others = session.deck.hand.filter((candidate) => candidate !== instance);
      if (handTimeBonusMinutes(session.deck) >= 8 || others.some((candidate) => fallbackCardRank(candidate) >= 820)) return false;
    }
    // Unattended fallback casting remains conservative; this is not a keep-value penalty.
    return card.kind === 'powerup' || (card.kind === 'curse' && !card.uncertainCasting);
  });
  return immediatelyUseful ? preferredPostAnswerCard(session, immediatelyUseful) : undefined;
}

export function preferredEarlyPowerupPlay(session: SecretSoloSession) {
  if ((session.questionNumber ?? 0) > 8) return undefined;
  const priority = new Map([
    ['discard-1-draw-2', 3],
    ['discard-2-draw-3', 2],
    ['expand-hand', 1],
  ]);
  const selected = legalDirectPostAnswerCards(session)
    .filter((instance) => priority.has(cardIdFromInstance(instance)))
    .sort((a, b) => (priority.get(cardIdFromInstance(b)) ?? 0) - (priority.get(cardIdFromInstance(a)) ?? 0))[0];
  return selected ? preferredPostAnswerCard(session, selected) : undefined;
}

export function finalTimeBonusMinutes(session: SecretSoloSession) {
  const held = handTimeBonusMinutes(session.deck);
  const bestTime = session.deck.hand.reduce((best, instance) => {
    const card = cardForInstance(instance);
    return card.kind === 'time-bonus' ? Math.max(best, card.smallMinutes ?? 0) : best;
  }, 0);
  const duplicates = session.deck.hand.filter((instance) => cardIdFromInstance(instance) === 'duplicate').length;
  return held + duplicates * bestTime + (session.bonusMinutes ?? 0);
}

export function publicCardNames(instances: CardInstanceId[] | undefined) {
  return (instances ?? []).map((instance) => CARD_CATALOG[cardIdFromInstance(instance)].name);
}
