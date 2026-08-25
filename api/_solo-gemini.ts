import { cardForInstance, type CardInstanceId } from '../src/cards';
import type { Constraint, Position } from '../src/types';
import { GEMINI_CALL_LIMIT, MAPS_CALL_LIMIT, fallbackKeep, fallbackPlay, legalPostAnswerCards, responseCardCanActAs } from './_solo-cards';
import type { SecretSoloSession } from './_solo-session';

declare const process: { env: Record<string, string | undefined> };

const MODEL = 'gemini-3.7-flash';
const API = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_INPUT_TOKENS = 4_000;
const MAX_OUTPUT_TOKENS = 1_024;
const GAME_BUDGET_MICROS = 750_000;
const MAP_RESERVATION_MICROS = 100_000;
const INPUT_MICROS_PER_TOKEN = 1.5;
const OUTPUT_MICROS_PER_TOKEN = 7.5;
const WORST_ORDINARY_MICROS = Math.ceil(MAX_INPUT_TOKENS * INPUT_MICROS_PER_TOKEN + MAX_OUTPUT_TOKENS * OUTPUT_MICROS_PER_TOKEN);

export type DrawChoiceGroup = { drawn: CardInstanceId[]; keep: number };
export type GeminiFallbackReason = 'call-limit' | 'rate-limit' | 'budget' | 'unavailable' | 'error';
export type StrategyChoice = {
  keeps: CardInstanceId[][];
  playCard?: CardInstanceId;
  source: 'gemini' | 'fallback';
  fallbackReason?: GeminiFallbackReason;
  fallbackDetail?: string;
};
export type ResponseChoice = {
  action: 'answer' | 'veto' | 'randomize';
  card?: CardInstanceId;
  fallbackReason?: GeminiFallbackReason;
  fallbackDetail?: string;
};

function fallback(
  session: SecretSoloSession,
  groups: DrawChoiceGroup[],
  fallbackReason?: GeminiFallbackReason,
  fallbackDetail?: string,
): StrategyChoice {
  return {
    keeps: groups.map((group) => fallbackKeep(group.drawn, group.keep, session.questionNumber ?? 0)),
    playCard: fallbackPlay(session),
    source: 'fallback',
    fallbackReason,
    fallbackDetail,
  };
}

function stableStrategyRoll(session: SecretSoloSession, label: string) {
  const source = `${session.sessionId}:${session.questionNumber ?? 0}:${label}`;
  return [...source].reduce((value, character) => (value * 33 + character.charCodeAt(0)) >>> 0, 5381) % 100;
}

function fallbackResponse(
  session: SecretSoloSession,
  responseCards: CardInstanceId[],
  replacementCount: number,
  fallbackReason?: GeminiFallbackReason,
  fallbackDetail?: string,
): ResponseChoice {
  const early = (session.questionNumber ?? 0) <= 8;
  const threshold = early ? 55 : 10;
  if (stableStrategyRoll(session, 'response') >= threshold) return { action: 'answer', fallbackReason, fallbackDetail };
  const randomize = responseCards.find((instance) => responseCardCanActAs(session, instance, 'randomize'));
  if (randomize && replacementCount > 0) {
    return { action: 'randomize', card: randomize, fallbackReason, fallbackDetail };
  }
  const veto = responseCards.find((instance) => responseCardCanActAs(session, instance, 'veto'));
  return veto ? { action: 'veto', card: veto, fallbackReason, fallbackDetail } : { action: 'answer', fallbackReason, fallbackDetail };
}

function failureDetail(stage: string, error: unknown) {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const message = raw.replace(/\s+/g, ' ').trim().slice(0, 300) || 'Unknown error';
  return `${stage}: ${message}`;
}

function enableHardFallback(session: SecretSoloSession, reason: 'call-limit' | 'budget') {
  if (!session.gemini) return;
  session.gemini.fallback = true;
  session.gemini.fallbackReason = reason;
}

function totalReserved(session: SecretSoloSession) {
  return (session.gemini?.spentMicros ?? 0) + (session.gemini?.reservedMapsMicros ?? 0);
}

function responseText(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const object = value as Record<string, unknown>;
  if (typeof object.output_text === 'string') return object.output_text;
  if (typeof object.text === 'string') return object.text;
  const outputs = [
    ...(Array.isArray(object.steps) ? object.steps : []),
    ...(Array.isArray(object.outputs) ? object.outputs : Array.isArray(object.output) ? object.output : []),
  ];
  for (const output of outputs) {
    if (!output || typeof output !== 'object') continue;
    const content = (output as Record<string, unknown>).content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const text = content.map((part) => part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string'
        ? (part as Record<string, unknown>).text : '').join('');
      if (text) return text;
    }
  }
  return undefined;
}

function usage(value: unknown) {
  const root = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const raw = (root.usage ?? root.usage_metadata ?? {}) as Record<string, unknown>;
  const input = Number(raw.total_input_tokens ?? raw.input_tokens ?? raw.prompt_token_count ?? raw.promptTokenCount ?? 0);
  const output = Number(raw.total_output_tokens ?? raw.output_tokens ?? raw.candidates_token_count ?? raw.candidatesTokenCount ?? 0);
  const thought = Number(raw.total_thought_tokens ?? raw.thoughts_token_count ?? raw.thoughtsTokenCount ?? 0);
  return {
    input: Number.isFinite(input) ? input : 0,
    output: (Number.isFinite(output) ? output : 0) + (Number.isFinite(thought) ? thought : 0),
  };
}

function jsonResponseFormat(schema: Record<string, unknown>) {
  return { type: 'text', mime_type: 'application/json', schema };
}

function mapsCitation(value: unknown): string | undefined {
  if (typeof value === 'string' && /^https:\/\/(?:www\.)?(?:google\.[^/]+\/maps|maps\.google\.)/i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = mapsCitation(item);
      if (found) return found;
    }
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      const found = mapsCitation(item);
      if (found) return found;
    }
  }
  return undefined;
}

function trimContext(context: Record<string, unknown>) {
  const copy = structuredClone(context) as Record<string, unknown>;
  if (Array.isArray(copy.recentQuestions)) {
    while (JSON.stringify(copy).length > 13_000 && copy.recentQuestions.length > 1) copy.recentQuestions.shift();
  }
  if (JSON.stringify(copy).length > 14_000) copy.recentQuestions = [];
  return copy;
}

async function countTokens(apiKey: string, prompt: string) {
  const response = await fetch(`${API}/models/${MODEL}:countTokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!response.ok) throw new Error(`Gemini token count failed (${response.status}).`);
  const body = await response.json() as { totalTokens?: number; total_tokens?: number };
  return Number(body.totalTokens ?? body.total_tokens ?? Infinity);
}

function validKeeps(groups: DrawChoiceGroup[], value: unknown): value is CardInstanceId[][] {
  if (!Array.isArray(value) || value.length !== groups.length) return false;
  return value.every((kept, index) => Array.isArray(kept) && kept.length === Math.min(groups[index].keep, groups[index].drawn.length) &&
    new Set(kept).size === kept.length && kept.every((instance) => groups[index].drawn.includes(instance as CardInstanceId)));
}

export async function chooseCardStrategy(
  session: SecretSoloSession,
  groups: DrawChoiceGroup[],
  constraint: Constraint,
  recentQuestions: Array<{ name: string; answer: string }>,
): Promise<StrategyChoice> {
  const builtIn = (reason?: GeminiFallbackReason, detail?: string) => fallback(session, groups, reason, detail);
  const potentialSession = structuredClone(session);
  potentialSession.deck.hand.push(...groups.flatMap((group) => group.keep > 0 ? group.drawn : []));
  const legalPlay = legalPostAnswerCards(potentialSession);
  const needsKeepChoice = groups.some((group) => group.keep > 0 && group.drawn.length > group.keep);
  if (!needsKeepChoice && legalPlay.length === 0) return builtIn();
  const gemini = session.gemini;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!gemini) return builtIn('unavailable', 'Card strategy: Gemini usage state is missing from the game session.');
  if (gemini.fallback) return builtIn(gemini.fallbackReason ?? 'call-limit', `Card strategy: persistent ${gemini.fallbackReason ?? 'call-limit'} fallback is active.`);
  if (!apiKey) return builtIn('unavailable', 'Card strategy: GEMINI_API_KEY is not configured on the server.');
  if (gemini.calls >= GEMINI_CALL_LIMIT) {
    enableHardFallback(session, 'call-limit');
    return builtIn('call-limit', `Card strategy: the ${GEMINI_CALL_LIMIT}-call game limit was reached.`);
  }
  const now = Date.now();
  gemini.recentCallTimes = gemini.recentCallTimes.filter((time) => now - Date.parse(time) < 60_000);
  if (gemini.recentCallTimes.length >= 4) return builtIn('rate-limit', 'Card strategy: four Gemini calls were already made in the rolling one-minute window.');
  if (totalReserved(session) + WORST_ORDINARY_MICROS > GAME_BUDGET_MICROS) {
    enableHardFallback(session, 'budget');
    return builtIn('budget', 'Card strategy: the next worst-case request would exceed the sealed game budget.');
  }

  const context = trimContext({
    phase: session.phase,
    questionNumber: session.questionNumber,
    currentQuestion: { name: constraint.name, kind: constraint.kind, category: constraint.category },
    hider: { position: session.spot, zoneStation: session.station.name },
    seeker: session.lastSeekerPosition ? { position: session.lastSeekerPosition, freshnessQuestions: (session.questionNumber ?? 0) - (session.lastSeekerQuestionNumber ?? 0), transitRoute: session.lastTransitRoute } : null,
    hand: session.deck.hand.map((instance) => ({ instance, ...cardForInstance(instance) })),
    drawGroups: groups.map((group) => ({ keep: group.keep, cards: group.drawn.map((instance) => ({ instance, ...cardForInstance(instance) })) })),
    legalPlayCards: legalPlay,
    activeEffects: session.activeEffects?.map(({ cardId, status, blocksQuestions, blocksTransit }) => ({ cardId, status, blocksQuestions, blocksTransit })),
    decisionHistory: session.recentDecisions,
    recentQuestions,
    strategyRoll: crypto.getRandomValues(new Uint32Array(1))[0] % 100,
  });
  const prompt = JSON.stringify({
    instruction: 'Choose which newly drawn cards to keep and optionally one legal card to play. A newly drawn card may be played immediately only if you also keep that exact card. During questions 1–8, actively take and spend useful non-curse power-ups instead of hoarding them; Veto and Randomize are especially early-game cards. Never choose a 2- or 4-minute bonus over Veto, Randomize, or an immediately playable curse without an uncertain casting condition. Six-, eight-, and twelve-minute bonuses remain premium scoring cards. Prefer time bonuses over curses with uncertain casting conditions. Later, retain useful endgame cards and premium time bonuses. Use strategyRoll to avoid predictable play. Return only schema-valid JSON. Never invent card ids.',
    state: context,
  });

  try {
    if (await countTokens(apiKey, prompt) > MAX_INPUT_TOKENS) throw new Error('Gemini input is too large.');
    gemini.calls += 1;
    gemini.recentCallTimes.push(new Date(now).toISOString());
    const response = await fetch(`${API}/interactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        model: MODEL,
        input: prompt,
        store: false,
        generation_config: { thinking_level: 'low', max_output_tokens: MAX_OUTPUT_TOKENS },
        response_format: jsonResponseFormat({
          type: 'object', additionalProperties: false,
          properties: {
            keeps: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
            playCard: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          }, required: ['keeps', 'playCard'],
        }),
      }),
    });
    if (!response.ok) throw new Error(`Gemini strategy failed (${response.status}).`);
    const body = await response.json();
    const measured = usage(body);
    gemini.inputTokens += measured.input;
    gemini.outputTokens += measured.output;
    gemini.spentMicros += Math.ceil(measured.input * INPUT_MICROS_PER_TOKEN + measured.output * OUTPUT_MICROS_PER_TOKEN);
    const parsed = JSON.parse(responseText(body) ?? '') as { keeps?: unknown; playCard?: unknown };
    if (!validKeeps(groups, parsed.keeps)) throw new Error('Gemini returned invalid keep choices.');
    const playCard = typeof parsed.playCard === 'string' ? parsed.playCard as CardInstanceId : undefined;
    if (playCard && !legalPlay.includes(playCard)) throw new Error('Gemini returned an illegal card play.');
    return { keeps: parsed.keeps, playCard, source: 'gemini' };
  } catch (error) {
    const detail = failureDetail('Card strategy', error);
    console.warn(`[Solo Gemini fallback] ${detail}`);
    return builtIn('error', detail);
  }
}

export async function chooseResponseStrategy(
  session: SecretSoloSession,
  constraint: Constraint,
  responseCards: CardInstanceId[],
  replacementCount: number,
): Promise<ResponseChoice> {
  const gemini = session.gemini;
  const apiKey = process.env.GEMINI_API_KEY;
  const builtIn = (reason?: GeminiFallbackReason, detail?: string) => fallbackResponse(session, responseCards, replacementCount, reason, detail);
  if (!responseCards.length) return { action: 'answer' };
  if (!gemini) return builtIn('unavailable', 'Response strategy: Gemini usage state is missing from the game session.');
  if (gemini.fallback) return builtIn(gemini.fallbackReason ?? 'call-limit', `Response strategy: persistent ${gemini.fallbackReason ?? 'call-limit'} fallback is active.`);
  if (!apiKey) return builtIn('unavailable', 'Response strategy: GEMINI_API_KEY is not configured on the server.');
  if (gemini.calls >= GEMINI_CALL_LIMIT) {
    enableHardFallback(session, 'call-limit');
    return builtIn('call-limit', `Response strategy: the ${GEMINI_CALL_LIMIT}-call game limit was reached.`);
  }
  const now = Date.now();
  gemini.recentCallTimes = gemini.recentCallTimes.filter((time) => now - Date.parse(time) < 60_000);
  if (gemini.recentCallTimes.length >= 4) return builtIn('rate-limit', 'Response strategy: four Gemini calls were already made in the rolling one-minute window.');
  if (totalReserved(session) + WORST_ORDINARY_MICROS > GAME_BUDGET_MICROS) {
    enableHardFallback(session, 'budget');
    return builtIn('budget', 'Response strategy: the next worst-case request would exceed the sealed game budget.');
  }
  const vetoCards = responseCards.filter((instance) => responseCardCanActAs(session, instance, 'veto'));
  const randomizeCards = responseCards.filter((instance) => responseCardCanActAs(session, instance, 'randomize'));
  const prompt = JSON.stringify({
    instruction: 'Decide whether to answer normally, veto, or randomize this question. During questions 1–8, lean strongly toward spending Veto or Randomize; prefer Randomize when both are legal. A listed Duplicate card legally copies a matching response card still in hand. The server, not you, chooses the random replacement. After question 8, use response cards sparingly. Use strategyRoll to avoid predictable timing. Return only schema-valid JSON.',
    question: { kind: constraint.kind, name: constraint.name, category: constraint.category, distanceMiles: constraint.distanceMiles },
    legal: { answer: true, vetoCards, randomizeCards: replacementCount ? randomizeCards : [] },
    strategyRoll: crypto.getRandomValues(new Uint32Array(1))[0] % 100,
  });
  try {
    if (await countTokens(apiKey, prompt) > MAX_INPUT_TOKENS) throw new Error('Gemini input is too large.');
    gemini.calls += 1;
    gemini.recentCallTimes.push(new Date(now).toISOString());
    const response = await fetch(`${API}/interactions`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        model: MODEL, input: prompt, store: false,
        generation_config: { thinking_level: 'low', max_output_tokens: MAX_OUTPUT_TOKENS },
        response_format: jsonResponseFormat({
          type: 'object', additionalProperties: false,
          properties: { action: { type: 'string', enum: ['answer', 'veto', 'randomize'] }, card: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
          required: ['action', 'card'],
        }),
      }),
    });
    if (!response.ok) throw new Error(`Gemini response strategy failed (${response.status}).`);
    const body = await response.json();
    const measured = usage(body);
    gemini.inputTokens += measured.input;
    gemini.outputTokens += measured.output;
    gemini.spentMicros += Math.ceil(measured.input * INPUT_MICROS_PER_TOKEN + measured.output * OUTPUT_MICROS_PER_TOKEN);
    const parsed = JSON.parse(responseText(body) ?? '') as { action?: unknown; card?: unknown };
    if (parsed.action === 'answer') return { action: 'answer' };
    if (parsed.action === 'veto' && typeof parsed.card === 'string' && vetoCards.includes(parsed.card as CardInstanceId)) return { action: 'veto', card: parsed.card as CardInstanceId };
    if (parsed.action === 'randomize' && typeof parsed.card === 'string' && randomizeCards.includes(parsed.card as CardInstanceId) && replacementCount > 0) {
      return { action: 'randomize', card: parsed.card as CardInstanceId };
    }
    throw new Error('Gemini chose an illegal response action.');
  } catch (error) {
    const detail = failureDetail('Response strategy', error);
    console.warn(`[Solo Gemini fallback] ${detail}`);
    return builtIn('error', detail);
  }
}

export type GroundedPlace = { name: string; position: Position; citationUrl?: string; country?: string };

function meters(a: Position, b: Position) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const lat = radians(b.lat - a.lat);
  const lng = radians(b.lng - a.lng);
  const value = Math.sin(lat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(lng / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(value));
}

export async function groundedPlace(
  session: SecretSoloSession,
  purpose: 'distant-cuisine' | 'mediocre-travel-agent',
  center: Position,
): Promise<GroundedPlace | undefined> {
  const cached = session.groundedPlaces?.find((entry) => entry.purpose === purpose && meters(entry.center, center) <= 25);
  if (cached) return { name: cached.name, position: cached.position, citationUrl: cached.citationUrl, country: cached.country };
  const gemini = session.gemini;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!gemini || gemini.fallback || !apiKey || gemini.calls >= GEMINI_CALL_LIMIT || gemini.mapsCalls >= MAPS_CALL_LIMIT ||
    totalReserved(session) + MAP_RESERVATION_MICROS > GAME_BUDGET_MICROS) return undefined;
  try {
    const prompt = purpose === 'distant-cuisine'
      ? 'Find one currently operating restaurant at or very near this point that explicitly serves cuisine from one specific foreign country. Return the restaurant, that country, exact Google Maps coordinates, and canonical Maps URL.'
      : 'Find one publicly accessible interesting place within 0.25 miles of this point. Return exact Google Maps coordinates and canonical Maps URL.';
    const input = `${prompt}\nCenter: ${center.lat},${center.lng}`;
    if (await countTokens(apiKey, input) > MAX_INPUT_TOKENS) return undefined;
    const now = Date.now();
    gemini.recentCallTimes = gemini.recentCallTimes.filter((time) => now - Date.parse(time) < 60_000);
    if (gemini.recentCallTimes.length >= 4) return undefined;
    gemini.calls += 1;
    gemini.mapsCalls += 1;
    gemini.recentCallTimes.push(new Date(now).toISOString());
    gemini.reservedMapsMicros += MAP_RESERVATION_MICROS;
    const response = await fetch(`${API}/interactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        model: MODEL, input, store: false,
        generation_config: { thinking_level: 'low', max_output_tokens: MAX_OUTPUT_TOKENS },
        tools: [{ type: 'google_maps', latitude: center.lat, longitude: center.lng }],
        response_format: jsonResponseFormat({
          type: 'object', additionalProperties: false,
          properties: { name: { type: 'string' }, country: { type: 'string' }, lat: { type: 'number' }, lng: { type: 'number' }, citationUrl: { type: 'string' } },
          required: purpose === 'distant-cuisine' ? ['name', 'country', 'lat', 'lng', 'citationUrl'] : ['name', 'lat', 'lng', 'citationUrl'],
        }),
      }),
    });
    if (!response.ok) return undefined;
    const body = await response.json();
    const measured = usage(body);
    gemini.inputTokens += measured.input;
    gemini.outputTokens += measured.output;
    const parsed = JSON.parse(responseText(body) ?? '') as { name?: unknown; country?: unknown; lat?: unknown; lng?: unknown; citationUrl?: unknown };
    if (typeof parsed.name !== 'string' || typeof parsed.lat !== 'number' || typeof parsed.lng !== 'number' ||
      !Number.isFinite(parsed.lat) || !Number.isFinite(parsed.lng) || parsed.lat < -90 || parsed.lat > 90 || parsed.lng < -180 || parsed.lng > 180) return undefined;
    const position = { lat: parsed.lat, lng: parsed.lng };
    if (meters(center, position) > 0.25 * 1609.344) return undefined;
    if (purpose === 'mediocre-travel-agent' && session.lastSeekerPosition &&
      meters(position, session.spot) <= meters(session.lastSeekerPosition, session.spot)) return undefined;
    if (purpose === 'distant-cuisine' && (typeof parsed.country !== 'string' || !parsed.country.trim())) return undefined;
    const place = {
      name: parsed.name.slice(0, 160), position,
      citationUrl: mapsCitation(body) ?? (typeof parsed.citationUrl === 'string' ? parsed.citationUrl : undefined),
      country: typeof parsed.country === 'string' ? parsed.country.trim().slice(0, 80) : undefined,
    };
    session.groundedPlaces = [...(session.groundedPlaces ?? []), { purpose, center, ...place }].slice(-MAPS_CALL_LIMIT);
    return place;
  } catch {
    return undefined;
  }
}

export const GEMINI_BUDGET_CONSTANTS = {
  maxCalls: GEMINI_CALL_LIMIT,
  maxInputTokens: MAX_INPUT_TOKENS,
  maxOutputTokens: MAX_OUTPUT_TOKENS,
  inputMicrosPerToken: INPUT_MICROS_PER_TOKEN,
  outputMicrosPerToken: OUTPUT_MICROS_PER_TOKEN,
  mapsCalls: MAPS_CALL_LIMIT,
  mapsReservationMicros: MAP_RESERVATION_MICROS,
  gameBudgetMicros: GAME_BUDGET_MICROS,
  worstCaseMicros: GEMINI_CALL_LIMIT * WORST_ORDINARY_MICROS + MAPS_CALL_LIMIT * MAP_RESERVATION_MICROS,
};
