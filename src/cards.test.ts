import { afterEach, describe, expect, it, vi } from 'vitest';
import { CARD_CATALOG, UNPLAYABLE_AI_CURSES, cardIdFromInstance, createDeck, deckCatalogCount, drawReward, enforceHandLimit, fallbackCardRank, type CardInstanceId } from './cards';
import { GEMINI_BUDGET_CONSTANTS, chooseCardStrategy, chooseResponseStrategy, groundedPlace } from '../api/_solo-gemini';
import { MOVE_QUESTION_THRESHOLD, SOLO_MAZE_SIZE, SPOTTY_MEMORY_CATEGORIES, advancePersistentEffects, curseCadenceAllows, deterministicMazeSvg, duplicatePostAnswerTarget, enforceKeepPriorities, fallbackKeep, fallbackPlay, finalTimeBonusMinutes, legalPostAnswerCards, legalResponseCards, moveTiming, playMoveCard, playPostAnswerCard, playResponseCard, preferredEarlyPowerupPlay, preferredMovePlay, preferredResponseCard, prepareQuestionReward, publicCardState } from '../api/_solo-cards';
import type { SecretSoloSession } from '../api/_solo-session';
import type { Constraint } from './types';
import { playSoloCards } from '../api/_solo-play';

function sessionWithHand(hand: CardInstanceId[], questionNumber = 1): SecretSoloSession {
  const now = new Date();
  const spot = { lat: 37.78, lng: -122.42 };
  return {
    kind: 'solo-session', version: 2, sessionId: 'card-test', createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 86_400_000).toISOString(), departureTime: now.toISOString(), transitScope: 'all',
    hidingTimeMinutes: 30, stationZoneMiles: 0.25,
    phase: 'seeking', cardsDrawn: 0, cardsKept: 0, questionUses: {}, wideHeading: 42,
    station: { id: 'station', name: 'Test Station', position: spot }, spot,
    panorama: { id: 'pano' }, stationPanorama: { id: 'station-pano' },
    route: { durationSeconds: 600, distanceMeters: 1000, departureTime: now.toISOString(), arrivalTime: new Date(now.getTime() + 600_000).toISOString(), summary: ['Test'] },
    questionNumber, activeEffects: [], blockedQuestionKeys: [], recentDecisions: [], publicMoves: [],
    deck: { drawPile: [], hand, discardPile: [], usedPile: [], maxHandSize: 6 },
  };
}

describe('official Xeno hider deck', () => {
  it('contains exactly 55 time bonuses, 21 powerups, and 24 curses', () => {
    const cards = Object.values(CARD_CATALOG);
    expect(deckCatalogCount()).toBe(100);
    expect(cards.filter((card) => card.kind === 'time-bonus').reduce((sum, card) => sum + card.count, 0)).toBe(55);
    expect(cards.filter((card) => card.kind === 'powerup').reduce((sum, card) => sum + card.count, 0)).toBe(21);
    expect(cards.filter((card) => card.kind === 'curse').reduce((sum, card) => sum + card.count, 0)).toBe(24);
  });

  it('has the official time-card counts and small-game values', () => {
    expect(['time-2', 'time-4', 'time-6', 'time-8', 'time-12'].map((id) => {
      const card = CARD_CATALOG[id as keyof typeof CARD_CATALOG];
      return [card.smallMinutes, card.count];
    })).toEqual([[2, 25], [4, 15], [6, 10], [8, 3], [12, 2]]);
  });

  it('documents the actual curse tiers relative to time-bonus keep priorities', () => {
    for (const card of Object.values(CARD_CATALOG).filter((card) => card.kind === 'curse')) {
      const rank = fallbackCardRank(`${card.id}#1`);
      const outranks = [2, 4, 6, 8, 12].filter((minutes) => rank > fallbackCardRank(`time-${minutes}#1` as CardInstanceId));
      expect(outranks, card.name).toEqual(!card.aiPlayable ? [] : card.id === 'u-turn' ? [2] : [2, 4, 6]);
      expect(rank, card.name).toBe(!card.aiPlayable ? 0 : card.id === 'u-turn' ? 250 : 900);
    }
  });

  it('only lowers supported curses with a concrete AI-handling limitation', () => {
    expect(Object.values(CARD_CATALOG).filter((card) => card.aiAwkwardReason).map((card) => card.id)).toEqual(['u-turn']);
    expect(CARD_CATALOG['u-turn'].aiAwkwardReason).toMatch(/live travel direction, next-stop, and connecting-service/);
    const standard = Object.values(CARD_CATALOG).filter((card) => card.kind === 'curse' && fallbackCardRank(`${card.id}#1`) === 900);
    expect(standard).toHaveLength(21);
  });

  it('ties Drained Brain with ordinary curses without overriding another tied model choice', () => {
    expect(fallbackCardRank('drained-brain#1')).toBe(fallbackCardRank('spotty-memory#1'));
    expect(fallbackKeep(['urban-explorer#1', 'drained-brain#1'], 1)).toEqual(['urban-explorer#1']);
    expect(enforceKeepPriorities(['drained-brain#1', 'urban-explorer#1'], ['urban-explorer#1'], 1)).toEqual(['urban-explorer#1']);
  });

  it.each(['bridge-troll', 'distant-cuisine', 'mediocre-travel-agent', 'unguided-tourist', 'water-weight'] as const)(
    'keeps %s above small bonuses without removing its casting-confirmation requirement', (id) => {
      const instance = `${id}#1` as const;
      expect(CARD_CATALOG[id].uncertainCasting).toBe(true);
      for (const minutes of [2, 4, 6]) {
        const time = `time-${minutes}#1` as CardInstanceId;
        expect(fallbackKeep([time, instance], 1)).toEqual([instance]);
        expect(enforceKeepPriorities([time, instance], [time], 1)).toEqual([instance]);
      }
      const session = sessionWithHand([instance, 'time-2#1', 'time-4#1', 'time-6#1', 'time-8#1', 'time-12#1', 'veto#1']);
      session.deck.maxHandSize = 4;
      expect(enforceHandLimit(session.deck)).toEqual(['time-2#1', 'time-4#1', 'time-6#1']);
      expect(session.deck.hand).toContain(instance);
    },
  );

  it('keeps only Cairn and Ransom Note unplayable and in the shuffled deck', () => {
    expect([...UNPLAYABLE_AI_CURSES].sort()).toEqual(['cairn', 'ransom-note']);
    const deck = createDeck(() => 0.5);
    expect(deck.drawPile).toHaveLength(100);
    expect(new Set(deck.drawPile)).toHaveLength(100);
    for (const id of UNPLAYABLE_AI_CURSES) expect(deck.drawPile.some((instance) => cardIdFromInstance(instance) === id)).toBe(true);
  });

  it('performs repeated rewards as separate groups and enforces overflow', () => {
    const deck = createDeck(() => 0.25);
    const groups = drawReward(deck, 3, 1, 3);
    expect(groups).toHaveLength(3);
    expect(groups.every((group) => group.drawn.length === 3 && group.kept.length === 1)).toBe(true);
    expect(new Set(groups.flatMap((group) => group.drawn))).toHaveLength(9);
    expect(deck.hand.length).toBeLessThanOrEqual(6);
  });

  it('keeps Move, Randomize, and Veto ahead of every time bonus at every stage', () => {
    const choices: CardInstanceId[] = ['time-12#1', 'veto#1', 'randomize#1', 'move#1', 'time-6#1'];
    expect(fallbackKeep(choices, 4, 3).map(cardIdFromInstance)).toEqual(['move', 'randomize', 'veto', 'time-12']);
    expect(cardIdFromInstance(fallbackKeep(choices, 1, 12)[0])).toBe('move');
  });

  it('overrides a model keep that drops a strategic card for a lower-priority card', () => {
    const drawn: CardInstanceId[] = ['time-8#1', 'move#1', 'time-4#1', 'lemon-phylactery#1'];
    expect(enforceKeepPriorities(drawn, ['time-4#1', 'lemon-phylactery#1'], 2).map(cardIdFromInstance)).toEqual(['move', 'time-8']);
  });

  it('keeps Veto and Randomize over 2-minute bonuses when the hand overflows', () => {
    const deck = {
      drawPile: [],
      hand: ['time-2#1', 'veto#1', 'randomize#1'] as CardInstanceId[],
      discardPile: [] as CardInstanceId[],
      usedPile: [] as CardInstanceId[],
      maxHandSize: 2,
    };
    expect(enforceHandLimit(deck)).toEqual(['time-2#1']);
    expect(deck.hand.map(cardIdFromInstance)).toEqual(['veto', 'randomize']);
  });

  it('corrects the logged Drained Brain and Lemon Phylactery draws over 2-minute bonuses', () => {
    const brain: CardInstanceId[] = ['drained-brain#1', 'time-2#1', 'urban-explorer#1'];
    const lemon: CardInstanceId[] = ['time-2#1', 'lemon-phylactery#1'];
    for (const drawn of [brain, lemon]) {
      expect(fallbackKeep(drawn, 1, 9)).toEqual([drawn === brain ? 'drained-brain#1' : 'lemon-phylactery#1']);
      expect(enforceKeepPriorities(drawn, ['time-2#1'], 1)).toEqual(fallbackKeep(drawn, 1, 9));
    }
    expect(enforceKeepPriorities(['time-2#1', 'time-6#1'], ['time-2#1'], 1)).toEqual(['time-6#1']);
    expect(fallbackKeep(['cairn#1', 'time-2#1'], 1)).toEqual(['time-2#1']);
  });

  it('keeps Duplicate and Drained Brain instead of low bonuses on overflow', () => {
    const session = sessionWithHand(['time-8#1', 'time-6#1', 'time-6#2', 'time-6#3', 'duplicate#1', 'time-2#1', 'drained-brain#1'], 9);
    expect(enforceHandLimit(session.deck)).toEqual(['time-2#1']);
    expect(session.deck.hand).toContain('duplicate#1');
    expect(session.deck.hand).toContain('drained-brain#1');
    expect(fallbackKeep(['duplicate#1', 'time-6#1'], 1)).toEqual(['duplicate#1']);
    expect(enforceKeepPriorities(['duplicate#1', 'time-6#1'], ['time-6#1'], 1)).toEqual(['duplicate#1']);
  });

  it('uses small bonuses before Duplicate or useful curses to pay casting costs', () => {
    const session = sessionWithHand(['spotty-memory#1', 'time-8#1', 'time-2#1', 'duplicate#1']);
    expect(playPostAnswerCard(session, 'spotty-memory#1').played).toBe(true);
    expect(session.deck.discardPile).toEqual(['time-2#1']);
    expect(session.deck.hand).toEqual(['time-8#1', 'duplicate#1']);
  });

  it('ranks response cards and immediately playable curses above 4-minute bonuses', () => {
    const choices: CardInstanceId[] = ['time-4#1', 'veto#1', 'randomize#1', 'lemon-phylactery#1'];
    expect(fallbackKeep(choices, 3, 13).map(cardIdFromInstance)).toEqual([
      'randomize', 'veto', 'lemon-phylactery',
    ]);
    expect(cardIdFromInstance(fallbackKeep(['time-12#1', 'time-4#1', 'lemon-phylactery#1'], 1, 13)[0])).toBe('time-12');
  });

  it('discards 4-minute bonuses before response cards and playable curses on overflow', () => {
    const deck = {
      drawPile: [],
      hand: ['time-4#1', 'time-4#2', 'time-6#1', 'time-8#1', 'randomize#1', 'lemon-phylactery#1'] as CardInstanceId[],
      discardPile: [] as CardInstanceId[],
      usedPile: [] as CardInstanceId[],
      maxHandSize: 4,
    };
    expect(enforceHandLimit(deck)).toEqual(['time-4#1', 'time-4#2']);
    expect(deck.hand.map(cardIdFromInstance)).toEqual(['time-6', 'time-8', 'randomize', 'lemon-phylactery']);
  });

  it('plays a newly kept discard-and-draw power-up early, preferring the cheaper version', () => {
    const session = sessionWithHand(['time-6#1', 'discard-2-draw-3#1', 'discard-1-draw-2#1'], 3);
    expect(cardIdFromInstance(preferredEarlyPowerupPlay(session)!)).toBe('discard-1-draw-2');
    session.questionNumber = 9;
    expect(preferredEarlyPowerupPlay(session)).toBeUndefined();
  });

  it('resolves a hand-cycling power-up privately without a public announcement or history entry', () => {
    const session = sessionWithHand(['time-2#1', 'time-6#1', 'discard-1-draw-2#1'], 3);
    expect(publicCardState(session).handCards).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'discard-1-draw-2', name: 'Discard 1, draw 2' }),
    ]));
    session.deck!.drawPile = ['time-4#1', 'veto#1'];
    const result = playPostAnswerCard(session, 'discard-1-draw-2#1');
    expect(result.played).toBe(true);
    expect(result.announcement).toBeUndefined();
    expect(session.recentDecisions?.at(-1)).toMatch(/^\[private\].*Discard 1, draw 2.*discarded 2-minute time bonus.*drew 4-minute time bonus, Veto question/i);
    expect(publicCardState(session).playHistory).toEqual([]);
  });

  it('also keeps Duplicate copying a discard-and-draw power-up private', () => {
    const session = sessionWithHand(['time-2#1', 'discard-1-draw-2#1', 'duplicate#1'], 3);
    session.deck.drawPile = ['time-4#1', 'veto#1'];
    const result = playPostAnswerCard(session, 'duplicate#1');
    expect(result).toMatchObject({ played: true, announcement: undefined });
    expect(session.recentDecisions?.at(-1)).toMatch(/^\[private\].*Duplicate another card as Discard 1, draw 2/i);
    expect(publicCardState(session).playHistory).toEqual([]);
  });

  it('does not expose the remaining physical-only curses as legal plays', () => {
    const session = sessionWithHand(['cairn#1', 'ransom-note#1']);
    expect(legalPostAnswerCards(session)).toEqual([]);
  });

  it('creates easy randomized Solo challenges for Luxury Car, Bird Guide, and Zoologist', () => {
    const cases = [
      ['luxury-car#1', 0, /at least \$30,000/],
      ['bird-guide#1', 0.5, /at least 10 seconds/],
      ['zoologist#1', 0.999, /wild bug/],
    ] as const;
    for (const [instance, roll, expected] of cases) {
      const session = sessionWithHand([instance]);
      expect(legalPostAnswerCards(session)).toContain(instance);
      const result = playPostAnswerCard(session, instance, () => roll);
      expect(result.played).toBe(true);
      expect(result.announcement).toMatch(expected);
      expect(publicCardState(session).activeCurses[0]).toEqual(expect.objectContaining({
        status: 'active', canClear: true, detail: expect.stringMatching(expected),
      }));
    }
  });

  it('enforces Question 1 to Question 3 curse cadence, including failed attempts', () => {
    const session = sessionWithHand([], 1);
    expect(curseCadenceAllows(session)).toBe(true);
    session.lastCurseQuestionNumber = 1;
    session.questionNumber = 2;
    expect(curseCadenceAllows(session)).toBe(false);
    session.questionNumber = 3;
    expect(curseCadenceAllows(session)).toBe(true);
  });

  it('keeps Spotty Memory visible, permanent, and rerolls only after later questions', () => {
    const session = sessionWithHand(['spotty-memory#1', 'time-2#1'], 1);
    const result = playPostAnswerCard(session, 'spotty-memory#1');
    expect(result.played).toBe(true);
    expect(SPOTTY_MEMORY_CATEGORIES).toContain(session.spottyMemoryCategory);
    expect(result.announcement).toContain('questions are disabled');
    expect(publicCardState(session)?.activeCurses[0]).toEqual(expect.objectContaining({
      cardId: 'spotty-memory', canClear: false,
      currentRestriction: expect.stringMatching(/^Currently disabled: /),
    }));

    const initialCategory = session.spottyMemoryCategory;
    advancePersistentEffects(session);
    expect(session.spottyMemoryCategory).toBe(initialCategory);
    session.questionNumber = 2;
    advancePersistentEffects(session);
    expect(SPOTTY_MEMORY_CATEGORIES).toContain(session.spottyMemoryCategory);
    expect(session.recentDecisions?.at(-1)).toMatch(/^Spotty Memory now disables .+ questions\.$/);
  });

  it('assigns an explicit lifecycle to every playable curse', () => {
    const expected = {
      'bridge-troll': 'manual-clear', 'distant-cuisine': 'manual-clear', 'drained-brain': 'persistent',
      'egg-partner': 'task-then-persistent', 'endless-tumble': 'manual-clear', 'gamblers-feet': 'timed',
      'hidden-hangman': 'hangman', 'impressionable-consumer': 'manual-clear', 'jammed-door': 'timed',
      labyrinth: 'manual-clear', 'lemon-phylactery': 'task-then-persistent',
      'luxury-car': 'manual-clear', 'mediocre-travel-agent': 'task-then-persistent', 'overflowing-chalice': 'question-counter',
      'right-turn': 'timed', 'spotty-memory': 'persistent', 'unguided-tourist': 'manual-clear',
      'bird-guide': 'manual-clear', 'u-turn': 'manual-clear', 'urban-explorer': 'persistent',
      'water-weight': 'task-then-persistent', zoologist: 'manual-clear',
    } as const;
    expect(Object.fromEntries(Object.keys(expected).map((id) => [id, CARD_CATALOG[id as keyof typeof CARD_CATALOG].resolution]))).toEqual(expected);
    expect(CARD_CATALOG['gamblers-feet'].smallDurationMinutes).toBe(20);
    expect(CARD_CATALOG['right-turn'].smallDurationMinutes).toBe(20);
    expect(CARD_CATALOG['jammed-door'].smallDurationMinutes).toBe(30);
  });

  it('can legally cast every AI-playable curse and exposes its instructions', () => {
    const playable = Object.values(CARD_CATALOG).filter((card) => card.kind === 'curse' && card.aiPlayable);
    for (const card of playable) {
      const instance = `${card.id}#1` as CardInstanceId;
      const session = sessionWithHand([instance, 'time-2#1', 'time-4#1', 'time-6#1', 'veto#1']);
      session.lastSeekerPosition = { lat: 37.88, lng: -122.42 };
      session.lastSeekerQuestionNumber = 1;
      session.lastTransitRoute = card.id === 'u-turn' ? 'N' : undefined;
      expect(legalPostAnswerCards(session), card.id).toContain(instance);
      const result = playPostAnswerCard(session, instance, () => 0);
      expect(result.played, card.id).toBe(true);
      expect(session.deck.usedPile, card.id).toContain(instance);
      const effect = session.activeEffects?.find((candidate) => candidate.cardInstance === instance);
      expect(effect, card.id).toBeDefined();
      expect(effect?.completionInstruction, card.id).toBeTruthy();
      expect(publicCardState(session).activeCurses.find((candidate) => candidate.cardId === card.id), card.id).toBeDefined();
    }
  });

  it('plays Duplicate as another held power-up while leaving the source card in hand', () => {
    const session = sessionWithHand(['duplicate#1', 'expand-hand#1', 'time-2#1']);
    session.deck.drawPile = ['time-4#1'];
    expect(legalPostAnswerCards(session)).toContain('duplicate#1');
    const result = playPostAnswerCard(session, 'duplicate#1');
    expect(result.announcement).toMatch(/Duplicate another card as Draw 1, expand 1/);
    expect(session.deck.usedPile).toContain('duplicate#1');
    expect(session.deck.hand).toContain('expand-hand#1');
    expect(session.deck.hand).toContain('time-4#1');
    expect(session.deck.maxHandSize).toBe(7);
  });

  it('selects Duplicate before an expansion source in both early and fallback play', () => {
    const session = sessionWithHand(['expand-hand#1', 'time-2#1', 'duplicate#1'], 3);
    expect(preferredEarlyPowerupPlay(session)).toBe('duplicate#1');
    expect(fallbackPlay(session)).toBe('duplicate#1');
  });

  it('marks Duplicate as an anytime play exempt from the per-question allowance', () => {
    expect(CARD_CATALOG.duplicate.timing).toBe('any-time');
    expect(CARD_CATALOG.duplicate.description).toContain('Does not count toward the one-card-per-question limit');
  });

  it('plays two free Duplicates and the original expansion in the same question', async () => {
    const session = sessionWithHand(['expand-hand#1', 'duplicate#1', 'duplicate#2', 'time-2#1'], 3);
    session.deck.drawPile = ['time-2#2', 'time-2#3', 'time-2#4'];
    const announcements = await playSoloCards(session, { selected: 'duplicate#1' });
    expect(session.deck.usedPile).toEqual(['duplicate#1', 'duplicate#2', 'expand-hand#1']);
    expect(session.deck.maxHandSize).toBe(9);
    expect(session.deck.hand).toEqual(['time-2#1', 'time-2#2', 'time-2#3', 'time-2#4']);
    expect(announcements).toHaveLength(3);
    expect(announcements.slice(0, 2).every((text) => text.includes('Duplicate another card'))).toBe(true);
  });

  it('plays a newly drawn Duplicate after the ordinary card, but not another ordinary card', async () => {
    const session = sessionWithHand(['expand-hand#1', 'bird-guide#1'], 3);
    session.deck.drawPile = ['duplicate#1'];
    await playSoloCards(session, { selected: 'expand-hand#1' });
    expect(session.deck.usedPile).toEqual(['expand-hand#1', 'duplicate#1']);
    expect(session.deck.hand).toEqual(['bird-guide#1']);
    expect(session.activeEffects).toEqual([expect.objectContaining({ cardId: 'bird-guide', cardInstance: 'duplicate#1' })]);
    expect(session.lastCurseQuestionNumber).toBeUndefined();
  });

  it('can play Duplicate independently when the normal allowance is unavailable or unused', async () => {
    for (const options of [{ allowNormal: false, selected: 'expand-hand#1' as const }, {}]) {
      const session = sessionWithHand(['expand-hand#1', 'duplicate#1']);
      await playSoloCards(session, options);
      expect(session.deck.usedPile).toEqual(['duplicate#1']);
      expect(session.deck.hand).toEqual(['expand-hand#1']);
      expect(session.deck.maxHandSize).toBe(7);
    }
  });

  it('allows a copied curse during normal curse cooldown without advancing it', async () => {
    const session = sessionWithHand(['duplicate#1', 'bird-guide#1', 'discard-1-draw-2#1', 'time-2#1'], 2);
    session.lastCurseQuestionNumber = 1;
    expect(legalPostAnswerCards(session)).not.toContain('bird-guide#1');
    expect(legalPostAnswerCards(session)).toContain('duplicate#1');
    await playSoloCards(session, { selected: 'discard-1-draw-2#1' });
    expect(session.deck.usedPile).toEqual(['duplicate#1', 'discard-1-draw-2#1']);
    expect(session.lastCurseQuestionNumber).toBe(1);
    expect(session.deck.discardPile).toEqual(['time-2#1']);
  });

  it('does not charge a failed Duplicate curse attempt to the normal curse allowance', () => {
    const session = sessionWithHand(['duplicate#1', 'endless-tumble#1'], 3);
    session.lastCurseQuestionNumber = 1;
    expect(playPostAnswerCard(session, 'duplicate#1', () => 0.99)).toMatchObject({ played: true, noEffect: true });
    expect(session.lastCurseQuestionNumber).toBe(1);
    expect(legalPostAnswerCards(session)).toContain('endless-tumble#1');
  });

  it('keeps a Duplicate plus ordinary hand-cycling sequence private', async () => {
    const session = sessionWithHand(['duplicate#1', 'discard-1-draw-2#1', 'time-2#1'], 3);
    session.deck.drawPile = ['time-2#2', 'time-2#3', 'time-2#4', 'time-2#5'];
    expect(await playSoloCards(session, { selected: 'discard-1-draw-2#1' })).toEqual([]);
    expect(session.deck.usedPile).toEqual(['duplicate#1', 'discard-1-draw-2#1']);
    expect(session.recentDecisions).toHaveLength(2);
    expect(session.recentDecisions?.every((decision) => decision.startsWith('[private]'))).toBe(true);
    expect(publicCardState(session).playHistory).toEqual([]);
  });

  it('does not use anytime copies in paused or completed games', async () => {
    for (const state of [{ pausedAt: new Date().toISOString() }, { phase: 'found' as const }, { phase: 'gave-up' as const }]) {
      const session = Object.assign(sessionWithHand(['expand-hand#1', 'duplicate#1']), state);
      expect(await playSoloCards(session, { selected: 'expand-hand#1' })).toEqual([]);
      expect(session.deck.usedPile).toEqual([]);
    }
  });

  it('preserves Duplicate for response cards or premium endgame scoring instead of a weaker copy', () => {
    for (const reserved of ['veto#1', 'randomize#1', 'time-12#1'] as CardInstanceId[]) {
      const session = sessionWithHand(['expand-hand#1', 'duplicate#1', reserved], 9);
      expect(fallbackPlay(session)).toBe('expand-hand#1');
      playPostAnswerCard(session, 'expand-hand#1');
      expect(session.deck.hand).toContain('duplicate#1');
    }
    const endgame = sessionWithHand(['time-12#1', 'duplicate#1', 'duplicate#2'], 15);
    endgame.phase = 'end-game';
    expect(fallbackPlay(endgame)).toBeUndefined();
    expect(finalTimeBonusMinutes(endgame)).toBe(36);
  });

  it('does not copy an already-active permanent curse', () => {
    const session = sessionWithHand(['spotty-memory#1', 'duplicate#1', 'time-2#1', 'time-2#2']);
    expect(playPostAnswerCard(session, 'duplicate#1').played).toBe(true);
    expect(session.deck.hand).toContain('spotty-memory#1');
    session.questionNumber = 3;
    expect(legalPostAnswerCards(session)).not.toContain('spotty-memory#1');
    expect(session.activeEffects).toHaveLength(1);
  });

  it('checks casting costs for the Duplicate instance, not only the source', () => {
    const session = sessionWithHand(['lemon-phylactery#1', 'duplicate#1']);
    expect(legalPostAnswerCards(session)).toContain('lemon-phylactery#1');
    expect(duplicatePostAnswerTarget(session, 'duplicate#1')).toBeUndefined();
    expect(playPostAnswerCard(session, 'duplicate#1').played).toBe(false);
    expect(session.deck.usedPile).toEqual([]);
  });

  it('retains Drained Brain instead of automatically discarding a valuable hand to cast it', () => {
    const valuable = sessionWithHand(['drained-brain#1', 'time-8#1', 'duplicate#1'], 9);
    expect(fallbackPlay(valuable)).toBeUndefined();
    const expendable = sessionWithHand(['drained-brain#1', 'time-2#1'], 9);
    expect(fallbackPlay(expendable)).toBe('drained-brain#1');
  });

  it('plays Duplicate as Veto or Randomize only when the copied response card is held', () => {
    const session = sessionWithHand(['duplicate#1', 'veto#1']);
    expect(legalResponseCards(session)).toEqual(expect.arrayContaining(['duplicate#1', 'veto#1']));
    expect(playResponseCard(session, 'duplicate#1', 'veto')).toBe(true);
    expect(session.deck.usedPile).toContain('duplicate#1');
    expect(session.deck.hand).toContain('veto#1');

    const withoutTarget = sessionWithHand(['duplicate#2', 'time-2#1']);
    expect(legalResponseCards(withoutTarget)).not.toContain('duplicate#2');
  });

  it('spends the original response card in the endgame when Duplicate can score a premium bonus', () => {
    const session = sessionWithHand(['veto#1', 'duplicate#1', 'time-12#1'], 15);
    session.phase = 'end-game';
    const selected = preferredResponseCard(session, legalResponseCards(session), 'veto');
    expect(selected).toBe('veto#1');
    expect(playResponseCard(session, selected!, 'veto')).toBe(true);
    expect(finalTimeBonusMinutes(session)).toBe(24);
  });

  it('reveals a usable old-station pin and resets movement state when Move succeeds', async () => {
    const session = sessionWithHand(['move#1', 'time-12#1', 'cairn#1'], MOVE_QUESTION_THRESHOLD);
    session.transitScope = 'primary';
    const previousSpot = session.spot;
    const nextSpot = { lat: 37.75, lng: -122.45 };
    const chooseLocation = vi.fn(async () => ({
      station: { id: 'new', name: 'New Station', lat: 37.751, lng: -122.451, score: 1 },
      route: { durationSeconds: 480, distanceMeters: 2000, departureTime: new Date().toISOString(), arrivalTime: new Date(Date.now() + 480_000).toISOString(), summary: ['N'] },
      panorama: { id: 'new-pano', position: nextSpot },
      stationPanorama: { id: 'new-station-pano', position: { lat: 37.751, lng: -122.451 } },
    }));
    const result = await playMoveCard(session, 'move#1', chooseLocation);
    expect(chooseLocation).toHaveBeenCalledWith(previousSpot, expect.any(String), 600, 'primary', 0.25);
    expect(result.announcement).toMatch(/Old station revealed: Test Station.*relocated immediately.*seekers may continue playing/i);
    expect(result.announcement).not.toMatch(/discard/i);
    expect(session.recentDecisions?.at(-1)).toMatch(/discarded.*12-minute time bonus.*Curse of the Cairn/i);
    expect(session.deck.hand).toEqual([]);
    expect(session.positionRevision).toBe(1);
    expect(session.lastRelocationQuestionNumber).toBe(MOVE_QUESTION_THRESHOLD);
    expect(publicCardState(session).moves[0]).toEqual(expect.objectContaining({
      oldStation: expect.objectContaining({ name: 'Test Station', position: { lat: 37.78, lng: -122.42 } }),
    }));
  });

  it('holds Move through question seven and prioritizes it from question eight', () => {
    const session = sessionWithHand(['move#1', 'time-12#1'], MOVE_QUESTION_THRESHOLD - 1);
    expect(fallbackKeep(['move#1', 'time-12#1'], 1)).toEqual(['move#1']);
    expect(legalPostAnswerCards(session)).not.toContain('move#1');
    expect(fallbackPlay(session)).toBeUndefined();
    expect(moveTiming(session)).toMatchObject({ ready: false, threshold: 8, questionsSinceRelocation: 7 });
    session.questionNumber = MOVE_QUESTION_THRESHOLD;
    expect(preferredMovePlay(session)).toBe('move#1');
    expect(fallbackPlay(session)).toBe('move#1');
  });

  it('does not let Duplicate or a direct Move call bypass the timing gate', async () => {
    const session = sessionWithHand(['move#1', 'duplicate#1'], MOVE_QUESTION_THRESHOLD - 1);
    const chooseLocation = vi.fn(async () => undefined);
    expect(duplicatePostAnswerTarget(session, 'duplicate#1')).toBeUndefined();
    expect(await playMoveCard(session, 'move#1', chooseLocation)).toEqual({ played: false });
    expect(await playMoveCard(session, 'duplicate#1', chooseLocation)).toEqual({ played: false });
    expect(chooseLocation).not.toHaveBeenCalled();
    expect(session.deck.hand).toEqual(['move#1', 'duplicate#1']);
    session.questionNumber = MOVE_QUESTION_THRESHOLD;
    expect(duplicatePostAnswerTarget(session, 'duplicate#1')).toBe('move#1');
  });

  it('starts the eight-question count again after relocation', () => {
    const session = sessionWithHand(['move#1'], 14);
    session.lastRelocationQuestionNumber = 10;
    expect(moveTiming(session)).toMatchObject({ ready: false, questionsSinceRelocation: 4 });
    expect(preferredMovePlay(session)).toBeUndefined();
    session.questionNumber = 18;
    expect(preferredMovePlay(session)).toBe('move#1');
  });

  it.each(['end-game', 'found', 'gave-up'] as const)('never moves in %s even after the threshold', async (phase) => {
    const session = sessionWithHand(['move#1', 'duplicate#1'], 20);
    session.phase = phase;
    const chooseLocation = vi.fn(async () => undefined);
    expect(preferredMovePlay(session)).toBeUndefined();
    expect(legalPostAnswerCards(session)).not.toContain('move#1');
    expect(await playMoveCard(session, 'move#1', chooseLocation)).toEqual({ played: false });
    expect(chooseLocation).not.toHaveBeenCalled();
  });

  it('keeps the hand and progress baseline intact if no Move destination is available', async () => {
    const session = sessionWithHand(['move#1', 'time-12#1'], 12);
    session.lastRelocationQuestionNumber = 2;
    expect(await playMoveCard(session, 'move#1', vi.fn(async () => undefined))).toEqual({ played: false });
    expect(session.lastRelocationQuestionNumber).toBe(2);
    expect(session.deck.hand).toEqual(['move#1', 'time-12#1']);
    expect(session.positionRevision).toBeUndefined();
  });

  it('applies Overflowing Chalice only to the next three questions that actually draw rewards', () => {
    const session = sessionWithHand(['overflowing-chalice#1', 'time-2#1']);
    session.deck.drawPile = ['time-4#1', 'time-6#1', 'time-8#1', 'time-12#1', 'veto#1', 'randomize#1'];
    expect(playPostAnswerCard(session, 'overflowing-chalice#1').played).toBe(true);
    expect(prepareQuestionReward(session, 0, 0, 1)[0].drawn).toEqual([]);
    expect(session.overflowingQuestionsRemaining).toBe(3);
    expect(prepareQuestionReward(session, 1, 1, 1)[0].drawn).toHaveLength(2);
    expect(session.overflowingQuestionsRemaining).toBe(2);
    prepareQuestionReward(session, 1, 1, 1);
    prepareQuestionReward(session, 1, 1, 1);
    expect(session.overflowingQuestionsRemaining).toBeUndefined();
    expect(session.activeEffects?.some((effect) => effect.cardId === 'overflowing-chalice')).toBe(false);
  });

  it('publishes reward changes from Impressionable Consumer and Overflowing Chalice', () => {
    const session = sessionWithHand(['impressionable-consumer#1']);
    expect(playPostAnswerCard(session, 'impressionable-consumer#1').played).toBe(true);
    expect(publicCardState(session)).toEqual(expect.objectContaining({ nextQuestionFree: true, nextRewardExtraDraw: 0 }));

    const chalice = sessionWithHand(['overflowing-chalice#1', 'time-2#1']);
    expect(playPostAnswerCard(chalice, 'overflowing-chalice#1').played).toBe(true);
    expect(publicCardState(chalice)).toEqual(expect.objectContaining({ nextQuestionFree: false, nextRewardExtraDraw: 1 }));
  });

  it('publishes the exact three Drained Brain questions and never offers a clear action', () => {
    const session = sessionWithHand(['drained-brain#1', 'time-2#1', 'time-4#1']);
    playPostAnswerCard(session, 'drained-brain#1');
    expect(session.blockedQuestionKeys).toHaveLength(3);
    const effect = publicCardState(session).activeCurses[0];
    expect(effect.currentRestriction).toMatch(/Radar.*Thermometer.*Measuring/);
    expect(effect.disabledQuestionKeys).toEqual(session.blockedQuestionKeys);
    expect(effect.canClear).toBe(false);
  });

  it('scores held time cards and held Duplicate cards at round end', () => {
    const session = sessionWithHand(['time-12#1', 'time-4#1', 'duplicate#1']);
    session.bonusMinutes = 5;
    expect(finalTimeBonusMinutes(session)).toBe(33);
  });

  it('generates the same solvable maze representation from the same seed', () => {
    const first = deterministicMazeSvg('game:4');
    expect(first).toBe(deterministicMazeSvg('game:4'));
    expect(SOLO_MAZE_SIZE).toBe(41);
    expect(first).toContain('viewBox="0 0 410 410"');
    expect(first.match(/<path /g)?.length).toBeGreaterThan(1_600);
    expect(first).toContain('Challenging 41 by 41 solvable maze');
    expect(first).toContain('START');
    expect(first).toContain('END');
  });
});

describe('Gemini hard budget', () => {
  it('proves the configured worst case stays below the sealed $0.75 ceiling', () => {
    expect(GEMINI_BUDGET_CONSTANTS.maxCalls).toBe(40);
    expect(GEMINI_BUDGET_CONSTANTS.maxInputTokens).toBe(4_000);
    expect(GEMINI_BUDGET_CONSTANTS.maxOutputTokens).toBe(1_024);
    expect(GEMINI_BUDGET_CONSTANTS.mapsCalls).toBe(2);
    expect(GEMINI_BUDGET_CONSTANTS.worstCaseMicros).toBeLessThan(GEMINI_BUDGET_CONSTANTS.gameBudgetMicros);
    expect(GEMINI_BUDGET_CONSTANTS.gameBudgetMicros).toBe(750_000);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GEMINI_API_KEY;
  });

  const question: Constraint = {
    id: 'q', name: 'Radar', kind: 'radar', enabled: true, answer: 'yes',
    origin: { lat: 37.77, lng: -122.42 }, distanceMiles: 1,
  };

  function strategySession() {
    const session = sessionWithHand([]);
    session.sessionId = 'test-game';
    session.spot = { lat: 37.78, lng: -122.42 };
    session.station = { id: 'station', name: 'Station', position: session.spot };
    session.gemini = { calls: 0, mapsCalls: 0, inputTokens: 0, outputTokens: 0, spentMicros: 0, reservedMapsMicros: 0, recentCallTimes: [], fallback: false };
    return session;
  }

  it('accepts a schema-valid legal choice and reconciles returned usage', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ totalTokens: 100 }))
      .mockResolvedValueOnce(Response.json({
        steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify({ keeps: [['time-12#1']], playCard: null }) }] }],
        usage: { total_input_tokens: 100, total_output_tokens: 20, total_thought_tokens: 5 },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const session = strategySession();
    const result = await chooseCardStrategy(session, [{ drawn: ['time-12#1', 'time-2#1'], keep: 1 }], question, []);
    expect(result).toEqual({ keeps: [['time-12#1']], playCard: undefined, source: 'gemini' });
    expect(session.gemini?.calls).toBe(1);
    expect(session.gemini?.inputTokens).toBe(100);
    expect(session.gemini?.outputTokens).toBe(25);
    const request = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(request.response_format).toEqual(expect.objectContaining({ type: 'text', mime_type: 'application/json' }));
    expect(request.response_format.schema).toEqual(expect.objectContaining({ type: 'object' }));
    expect(request.response_format).not.toHaveProperty('json_schema');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('links a grounded destination to the validated structured point, not an unrelated citation', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ totalTokens: 100 }))
      .mockResolvedValueOnce(Response.json({
        output_text: JSON.stringify({
          name: 'Sunset Reservoir Park', lat: 37.769, lng: -122.441,
          citationUrl: 'https://www.google.com/maps/place/Golden+Gate+Park',
        }),
        citations: ['https://www.google.com/maps/place/Golden+Gate+Park'],
        usage: { total_input_tokens: 80, total_output_tokens: 12 },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const session = strategySession();
    const place = await groundedPlace(session, 'mediocre-travel-agent', { lat: 37.77, lng: -122.44 });
    expect(place).toMatchObject({ name: 'Sunset Reservoir Park', position: { lat: 37.769, lng: -122.441 } });
    expect(place?.citationUrl).toContain('query=37.769%2C-122.441');
    expect(place?.citationUrl).not.toMatch(/Golden.Gate.Park/i);
  });

  it('grounds Distant Cuisine as a reference without requesting Street View or moving Xeno', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ totalTokens: 100 }))
      .mockResolvedValueOnce(Response.json({ output_text: JSON.stringify({ name: 'Reference Restaurant', country: 'Peru', lat: 37.7805, lng: -122.42, citationUrl: 'https://example.test/restaurant' }) }));
    vi.stubGlobal('fetch', fetchMock);
    const session = strategySession();
    session.deck.hand = ['distant-cuisine#1'];
    const originalSpot = structuredClone(session.spot);
    const originalPanorama = structuredClone(session.panorama);
    await playSoloCards(session, { selected: 'distant-cuisine#1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes('generativelanguage.googleapis.com'))).toBe(true);
    expect(session.spot).toEqual(originalSpot);
    expect(session.panorama).toEqual(originalPanorama);
    expect(session.activeEffects?.[0]).toMatchObject({
      cardId: 'distant-cuisine', status: 'pending', placeName: 'Reference Restaurant',
      proposedPosition: { lat: 37.7805, lng: -122.42 }, detail: expect.stringContaining('Xeno has not moved'),
    });
    expect(session.activeEffects?.[0].proposedPanorama).toBeUndefined();
  });

  it('lets Gemini play a card it keeps from the current draw', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ totalTokens: 100 }))
      .mockResolvedValueOnce(Response.json({
        output_text: JSON.stringify({ keeps: [['discard-1-draw-2#1']], playCard: 'discard-1-draw-2#1' }),
        usage: { total_input_tokens: 80, total_output_tokens: 12 },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const session = strategySession();
    session.deck.hand = ['time-4#1'];
    const result = await chooseCardStrategy(session, [{ drawn: ['discard-1-draw-2#1', 'time-2#1'], keep: 1 }], question, []);
    expect(result).toEqual({ keeps: [['discard-1-draw-2#1']], playCard: 'discard-1-draw-2#1', source: 'gemini' });
    const prompt = String(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).input);
    expect(prompt).toContain('discard-1-draw-2#1');
    expect(prompt).toContain('newly drawn card may be played immediately');
  });

  it('overrides Gemini choosing the logged 2-minute bonus over Drained Brain', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ totalTokens: 100 }))
      .mockResolvedValueOnce(Response.json({ output_text: JSON.stringify({ keeps: [['time-2#1']], playCard: null }) })));
    const session = strategySession();
    session.questionNumber = 9;
    const result = await chooseCardStrategy(session, [{ drawn: ['drained-brain#1', 'time-2#1', 'urban-explorer#1'], keep: 1 }], question, []);
    expect(result.source).toBe('gemini');
    expect(result.keeps).toEqual([['drained-brain#1']]);
  });

  it.each([null, 'expand-hand#1'])('prioritizes a ready Move when Gemini selects %s', async (playCard) => {
    process.env.GEMINI_API_KEY = 'test-key';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ totalTokens: 100 }))
      .mockResolvedValueOnce(Response.json({ output_text: JSON.stringify({ keeps: [], playCard }) }));
    vi.stubGlobal('fetch', fetchMock);
    const session = strategySession();
    session.questionNumber = MOVE_QUESTION_THRESHOLD;
    session.deck.hand = ['move#1', 'expand-hand#1'];
    expect(await chooseCardStrategy(session, [], question, [])).toMatchObject({ source: 'gemini', playCard: 'move#1' });
    const prompt = JSON.parse(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).input);
    expect(prompt.state.moveTiming).toMatchObject({ ready: true, threshold: 8, questionsSinceRelocation: 8 });
  });

  it('overrides a premature Gemini Move without calling relocation', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ totalTokens: 100 }))
      .mockResolvedValueOnce(Response.json({ output_text: JSON.stringify({ keeps: [], playCard: 'move#1' }) })));
    const session = strategySession();
    session.questionNumber = MOVE_QUESTION_THRESHOLD - 1;
    session.deck.hand = ['move#1', 'expand-hand#1'];
    const result = await chooseCardStrategy(session, [], question, []);
    expect(result.source).toBe('fallback');
    expect(result.playCard).toBe('expand-hand#1');
    expect(session.deck.hand).toContain('move#1');
  });

  it.each([false, true])('reserves the ordinary response slot for a ready Move (Gemini enabled: %s)', async (geminiEnabled) => {
    if (geminiEnabled) process.env.GEMINI_API_KEY = 'test-key';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const session = strategySession();
    session.questionNumber = MOVE_QUESTION_THRESHOLD;
    session.deck.hand = ['move#1', 'randomize#1', 'veto#1'];
    expect(await chooseResponseStrategy(session, question, legalResponseCards(session), 2)).toEqual({ action: 'answer' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prioritizes a newly drawn Move at the threshold in fallback mode', async () => {
    const session = strategySession();
    session.questionNumber = MOVE_QUESTION_THRESHOLD;
    const result = await chooseCardStrategy(session, [{ drawn: ['move#1', 'time-12#1'], keep: 1 }], question, []);
    expect(result).toMatchObject({ source: 'fallback', keeps: [['move#1']], playCard: 'move#1' });
  });

  it.each(['veto', 'randomize'] as const)('spends Duplicate before the original %s for Gemini and fallback responses', async (action) => {
    const source = `${action}#1` as CardInstanceId;
    process.env.GEMINI_API_KEY = 'test-key';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ totalTokens: 100 }))
      .mockResolvedValueOnce(Response.json({ output_text: JSON.stringify({ action, card: source }) }));
    vi.stubGlobal('fetch', fetchMock);
    const session = strategySession();
    session.deck.hand = [source, 'duplicate#1', 'duplicate#2'];
    const model = await chooseResponseStrategy(session, question, legalResponseCards(session), 2);
    expect(model).toMatchObject({ action, card: 'duplicate#1' });
    const prompt = JSON.parse(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).input);
    expect(prompt).toMatchObject({ phase: 'seeking', questionNumber: 1 });

    delete process.env.GEMINI_API_KEY;
    // Exercise the deterministic fallback's spending branch without relying on one seed.
    let copied = false;
    for (let index = 0; index < 100 && !copied; index += 1) {
      session.sessionId = `copy-response-${index}`;
      const fallback = await chooseResponseStrategy(session, question, legalResponseCards(session), 2);
      if (fallback.action === 'answer') continue;
      expect(fallback).toMatchObject({ action, card: 'duplicate#1' });
      expect(playResponseCard(session, fallback.card!, action)).toBe(true);
      expect(session.deck.hand).toEqual([source, 'duplicate#2']);
      copied = true;
    }
    expect(copied).toBe(true);
  });

  it('uses Duplicate when Gemini selects its expansion source', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ totalTokens: 100 }))
      .mockResolvedValueOnce(Response.json({ output_text: JSON.stringify({ keeps: [], playCard: 'expand-hand#1' }) })));
    const session = strategySession();
    session.deck.hand = ['expand-hand#1', 'duplicate#1', 'time-2#1'];
    const result = await chooseCardStrategy(session, [], question, []);
    expect(result).toMatchObject({ source: 'gemini', playCard: 'duplicate#1' });
  });

  it('does not silently change a modeled Duplicate target when that source is not kept', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ totalTokens: 100 }))
      .mockResolvedValueOnce(Response.json({ output_text: JSON.stringify({ keeps: [['veto#1']], playCard: 'duplicate#1' }) })));
    const session = strategySession();
    session.deck.hand = ['right-turn#1', 'duplicate#1', 'time-2#1'];
    const result = await chooseCardStrategy(session, [{ drawn: ['expand-hand#1', 'veto#1'], keep: 1 }], question, []);
    expect(result).toMatchObject({ source: 'gemini', keeps: [['veto#1']], playCard: undefined });
  });

  it('corrects a model keeping six minutes over Water Weight, with no blanket uncertainty penalty', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ totalTokens: 100 }))
      .mockResolvedValueOnce(Response.json({ output_text: JSON.stringify({ keeps: [['time-6#1']], playCard: null }) }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await chooseCardStrategy(strategySession(), [{ drawn: ['time-6#1', 'water-weight#1'], keep: 1 }], question, []);
    expect(result).toMatchObject({ source: 'gemini', keeps: [['water-weight#1']] });
    const prompt = JSON.parse(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).input);
    expect(prompt.instruction).toContain('A casting condition or confirmation requirement alone is not a reason to downgrade a curse');
    expect(prompt.instruction).toContain('same keep priority, including Drained Brain');
  });

  it('does not spend a Gemini call when there is no keep or play decision', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const session = strategySession();
    const result = await chooseCardStrategy(session, [{ drawn: ['time-12#1'], keep: 1 }], question, []);
    expect(result).toEqual({ keeps: [['time-12#1']], playCard: undefined, source: 'fallback', fallbackReason: undefined });
    expect(session.gemini?.calls).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', Response.json({ output_text: '{nope', usage: {} }), 'Card strategy: SyntaxError:'],
    ['429', new Response('', { status: 429 }), 'Card strategy: Error: Gemini strategy failed (429).'],
    ['5xx', new Response('', { status: 503 }), 'Card strategy: Error: Gemini strategy failed (503).'],
  ])('falls back without retrying on %s', async (_label, interactionResponse, expectedDetail) => {
    process.env.GEMINI_API_KEY = 'test-key';
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ totalTokens: 100 })).mockResolvedValueOnce(interactionResponse);
    vi.stubGlobal('fetch', fetchMock);
    const session = strategySession();
    const result = await chooseCardStrategy(session, [{ drawn: ['time-12#1', 'time-2#1'], keep: 1 }], question, []);
    expect(result.source).toBe('fallback');
    expect(result.fallbackReason).toBe('error');
    expect(result.fallbackDetail).toContain(expectedDetail);
    expect(session.gemini?.fallback).toBe(false);
    expect(session.gemini?.fallbackReason).toBeUndefined();
    expect(session.gemini?.calls).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('tries Gemini again on the next decision after a transient failure', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ totalTokens: 100 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ totalTokens: 100 }))
      .mockResolvedValueOnce(Response.json({
        steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify({ keeps: [['time-12#1']], playCard: null }) }] }],
        usage: { total_input_tokens: 100, total_output_tokens: 20 },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const session = strategySession();
    const first = await chooseCardStrategy(session, [{ drawn: ['time-12#1', 'time-2#1'], keep: 1 }], question, []);
    const second = await chooseCardStrategy(session, [{ drawn: ['time-12#1', 'time-2#1'], keep: 1 }], question, []);
    expect(first).toEqual(expect.objectContaining({ source: 'fallback', fallbackReason: 'error' }));
    expect(second).toEqual(expect.objectContaining({ source: 'gemini' }));
    expect(session.gemini).toEqual(expect.objectContaining({ calls: 2, fallback: false }));
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not call Gemini after the sealed budget is exhausted', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const session = strategySession();
    session.gemini!.spentMicros = GEMINI_BUDGET_CONSTANTS.gameBudgetMicros;
    expect((await chooseCardStrategy(session, [{ drawn: ['time-2#1', 'time-4#1'], keep: 1 }], question, [])).source).toBe('fallback');
    expect(session.gemini?.fallbackReason).toBe('budget');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports the call limit only when the 40-call cap is actually reached', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const session = strategySession();
    session.gemini!.calls = GEMINI_BUDGET_CONSTANTS.maxCalls;
    expect((await chooseCardStrategy(session, [{ drawn: ['time-2#1', 'time-4#1'], keep: 1 }], question, [])).source).toBe('fallback');
    expect(session.gemini?.fallbackReason).toBe('call-limit');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exposes grouped hand cards for the optional hand disclosure without leaking instance ids', () => {
    const session = strategySession();
    session.deck!.hand = ['time-12#1', 'time-12#2', 'cairn#1'];
    const projection = publicCardState(session)!;
    expect(projection.handCount).toBe(3);
    expect(projection.handCards).toEqual([
      expect.objectContaining({ id: 'time-12', name: '12-minute time bonus', count: 2 }),
      expect.objectContaining({ id: 'cairn', name: 'Curse of the Cairn', count: 1 }),
    ]);
    expect(JSON.stringify(projection)).not.toContain('time-12#1');
    expect(JSON.stringify(projection)).not.toContain('cairn#1');
  });
});
