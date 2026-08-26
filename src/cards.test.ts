import { afterEach, describe, expect, it, vi } from 'vitest';
import { CARD_CATALOG, UNPLAYABLE_AI_CURSES, cardIdFromInstance, createDeck, deckCatalogCount, drawReward, enforceHandLimit, type CardInstanceId } from './cards';
import { GEMINI_BUDGET_CONSTANTS, chooseCardStrategy, groundedPlace } from '../api/_solo-gemini';
import { SOLO_MAZE_SIZE, SPOTTY_MEMORY_CATEGORIES, advancePersistentEffects, curseCadenceAllows, deterministicMazeSvg, fallbackKeep, finalTimeBonusMinutes, legalPostAnswerCards, legalResponseCards, playMoveCard, playPostAnswerCard, playResponseCard, preferredEarlyPowerupPlay, prepareQuestionReward, publicCardState } from '../api/_solo-cards';
import type { SecretSoloSession } from '../api/_solo-session';
import type { Constraint } from './types';

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

  it('takes response power-ups ahead of time bonuses early, then shifts toward scoring', () => {
    const choices: CardInstanceId[] = ['time-12#1', 'veto#1', 'randomize#1'];
    expect(fallbackKeep(choices, 2, 3).map(cardIdFromInstance)).toEqual(['veto', 'randomize']);
    expect(cardIdFromInstance(fallbackKeep(choices, 1, 12)[0])).toBe('time-12');
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

  it('ranks response cards and immediately playable curses above 4-minute bonuses', () => {
    const choices: CardInstanceId[] = ['time-4#1', 'veto#1', 'randomize#1', 'lemon-phylactery#1'];
    expect(fallbackKeep(choices, 3, 13).map(cardIdFromInstance)).toEqual([
      'veto', 'randomize', 'lemon-phylactery',
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

  it('plays Duplicate as Veto or Randomize only when the copied response card is held', () => {
    const session = sessionWithHand(['duplicate#1', 'veto#1']);
    expect(legalResponseCards(session)).toEqual(expect.arrayContaining(['duplicate#1', 'veto#1']));
    expect(playResponseCard(session, 'duplicate#1', 'veto')).toBe(true);
    expect(session.deck.usedPile).toContain('duplicate#1');
    expect(session.deck.hand).toContain('veto#1');

    const withoutTarget = sessionWithHand(['duplicate#2', 'time-2#1']);
    expect(legalResponseCards(withoutTarget)).not.toContain('duplicate#2');
  });

  it('reveals a usable old-station pin and resets movement state when Move succeeds', async () => {
    const session = sessionWithHand(['move#1', 'time-12#1', 'cairn#1']);
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
    expect(publicCardState(session).moves[0]).toEqual(expect.objectContaining({
      oldStation: expect.objectContaining({ name: 'Test Station', position: { lat: 37.78, lng: -122.42 } }),
    }));
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
    expect(SOLO_MAZE_SIZE).toBe(21);
    expect(first).toContain('viewBox="0 0 294 294"');
    expect(first.match(/<path /g)?.length).toBeGreaterThan(400);
    expect(first).toContain('Challenging 21 by 21 solvable maze');
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
