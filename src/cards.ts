export type CardKind = 'time-bonus' | 'powerup' | 'curse';
export type CardTiming = 'round-end' | 'response-window' | 'after-answer' | 'any-legal-window';
export type CardResolution = 'immediate' | 'manual-clear' | 'timed' | 'persistent' | 'task-then-persistent' | 'hangman' | 'question-counter';

export type CardId =
  | 'time-2' | 'time-4' | 'time-6' | 'time-8' | 'time-12'
  | 'discard-1-draw-2' | 'discard-2-draw-3' | 'expand-hand' | 'duplicate' | 'move' | 'randomize' | 'veto'
  | 'bridge-troll' | 'cairn' | 'distant-cuisine' | 'drained-brain' | 'egg-partner' | 'endless-tumble'
  | 'gamblers-feet' | 'hidden-hangman' | 'impressionable-consumer' | 'jammed-door' | 'labyrinth'
  | 'lemon-phylactery' | 'luxury-car' | 'mediocre-travel-agent' | 'overflowing-chalice'
  | 'ransom-note' | 'right-turn' | 'spotty-memory' | 'bird-guide' | 'unguided-tourist' | 'u-turn'
  | 'urban-explorer' | 'water-weight' | 'zoologist';

export type CardDefinition = {
  id: CardId;
  kind: CardKind;
  name: string;
  count: number;
  description: string;
  smallMinutes?: number;
  aiPlayable?: boolean;
  uncertainCasting?: boolean;
  blocksQuestions?: boolean;
  blocksTransit?: boolean;
  endgameAllowed?: boolean;
  failureBonusMinutes?: number;
  discardCost?: number;
  discardKind?: CardKind;
  castingInstruction?: string;
  failureInstruction?: string;
  resolution: CardResolution;
  smallDurationMinutes?: number;
  timing: CardTiming;
  completionInstruction: string;
};

const time = (id: CardId, minutes: number, count: number): CardDefinition => ({
  id, kind: 'time-bonus', name: `${minutes}-minute time bonus`, count, smallMinutes: minutes,
  description: `Worth ${minutes} minutes if it remains in the hider's hand at the end of the round.`,
  resolution: 'immediate', timing: 'round-end', completionInstruction: 'Keep this card in hand until the round is scored.',
});

const powerup = (id: CardId, name: string, count: number, description: string): CardDefinition => ({
  id, kind: 'powerup', name, count, description, aiPlayable: true, endgameAllowed: id !== 'move',
  resolution: 'immediate',
  timing: id === 'veto' || id === 'randomize' ? 'response-window' : id === 'duplicate' ? 'any-legal-window' : 'after-answer',
  completionInstruction: 'The server resolves this power-up immediately and records it in public play history.',
});

const curse = (
  id: CardId,
  name: string,
  description: string,
  options: Partial<CardDefinition> = {},
): CardDefinition => ({
  id, kind: 'curse', name, count: 1, description, aiPlayable: true, endgameAllowed: true,
  resolution: 'manual-clear', timing: 'after-answer',
  completionInstruction: 'Seekers perform the printed task on the honor system, then report completion with Cleared.',
  ...options,
});

export const CARD_CATALOG: Record<CardId, CardDefinition> = Object.fromEntries(([
  time('time-2', 2, 25),
  time('time-4', 4, 15),
  time('time-6', 6, 10),
  time('time-8', 8, 3),
  time('time-12', 12, 2),
  powerup('discard-1-draw-2', 'Discard 1, draw 2', 4, 'Discard one other card, then draw and keep two cards.'),
  powerup('discard-2-draw-3', 'Discard 2, draw 3', 4, 'Discard two other cards, then draw and keep three cards.'),
  powerup('expand-hand', 'Draw 1, expand 1', 2, 'Draw one card and increase the maximum hand size by one.'),
  powerup('duplicate', 'Duplicate another card', 2, 'Play as a copy of another card currently in hand.'),
  powerup('move', 'Move', 1, 'Discard the hand, reveal the old station, and immediately establish a new hiding zone selected through the Solo relocation pipeline.'),
  powerup('randomize', 'Randomize question', 4, 'Replace the pending question with a random unasked question from the same category.'),
  powerup('veto', 'Veto question', 4, 'Give no answer and earn no reward; the question still counts as asked.'),
  curse('bridge-troll', 'Curse of the Bridge Troll', 'The seekers must ask their next question from under a bridge.', { uncertainCasting: true, blocksQuestions: true, castingInstruction: 'The seekers must be at least 5 miles from the hider.', completionInstruction: 'Ask the next question from under a bridge, then report the curse cleared.' }),
  curse('cairn', 'Curse of the Cairn', 'Build opposing freestanding rock towers before another question.', { aiPlayable: false, blocksQuestions: true, castingInstruction: 'The hider must first build the qualifying rock tower.' }),
  curse('distant-cuisine', 'Curse of the Distant Cuisine', 'Seekers must visit a restaurant serving food from a country at least as far away as the hider’s restaurant country before asking another question.', { uncertainCasting: true, blocksQuestions: true, castingInstruction: 'The hider must be at the selected restaurant inside the hiding zone.', completionInstruction: 'Visit a qualifying restaurant, then report the curse cleared.' }),
  curse('drained-brain', 'Curse of the Drained Brain', 'Three specific questions from different categories are disabled for the rest of the run.', { castingInstruction: 'Discard the entire hand.', resolution: 'persistent', completionInstruction: 'This restriction remains active for the rest of the game.' }),
  curse('egg-partner', 'Curse of the Egg Partner', 'The seekers must acquire an egg before asking another question. It then remains an official team member for the rest of the run.', { blocksQuestions: true, endgameAllowed: false, failureBonusMinutes: 30, failureInstruction: 'Report if the egg cracks or any team member is abandoned.', discardCost: 2, resolution: 'task-then-persistent', completionInstruction: 'Report when the egg has been acquired; the app will continue tracking it.' }),
  curse('endless-tumble', 'Curse of the Endless Tumble', 'Seekers must roll a die at least 100 feet unaided and have it land on 5 or 6 before asking another question.', { blocksQuestions: true, failureBonusMinutes: 10, failureInstruction: 'Report if the rolling die accidentally hits someone.', castingInstruction: 'Roll a die; on 5 or 6 the curse has no effect.', completionInstruction: 'Complete the qualifying 100-foot roll, then report the curse cleared.' }),
  curse('gamblers-feet', "Curse of the Gambler's Feet", 'For 20 minutes, seekers must roll a die before taking steps and may take only that many steps before rolling again.', { castingInstruction: 'Roll a die; on an even number the curse has no effect.', resolution: 'timed', smallDurationMinutes: 20, completionInstruction: 'The effect expires automatically after 20 minutes.' }),
  curse('hidden-hangman', 'Curse of the Hidden Hangman', 'Seekers must beat the hider at five-letter Hangman before asking another question or boarding transportation.', { blocksQuestions: true, blocksTransit: true, discardCost: 2, resolution: 'hangman', completionInstruction: 'Solve Hangman in the controls below. A loss starts the required 10-minute wait.' }),
  curse('impressionable-consumer', 'Curse of the Impressionable Consumer', 'Seekers must enter a location or buy a product from a physical advertisement found at least 100 feet away before asking another question.', { blocksQuestions: true, castingInstruction: 'The seekers’ next question is free and gives the hider no card reward.', completionInstruction: 'Act on the qualifying advertisement, then report the curse cleared.' }),
  curse('jammed-door', 'Curse of the Jammed Door', 'For 30 minutes, seekers must roll at least 7 on two dice before entering a building, business, train, or other vehicle. A failed doorway can be retried after 5 minutes.', { discardCost: 2, resolution: 'timed', smallDurationMinutes: 30, completionInstruction: 'The effect expires automatically after 30 minutes.' }),
  curse('labyrinth', 'Curse of the Labyrinth', 'Seekers must solve the generated maze before asking another question.', { blocksQuestions: true, castingInstruction: 'Generate a solvable maze without researching a design.', completionInstruction: 'Solve the displayed maze, then report the curse cleared.' }),
  curse('lemon-phylactery', 'Curse of the Lemon Phylactery', 'Each seeker must affix a lemon to their outermost clothing or skin before asking another question, then keep it touching for the rest of the run.', { blocksQuestions: true, endgameAllowed: false, failureBonusMinutes: 30, failureInstruction: 'Report if a lemon stops touching a seeker.', discardCost: 1, discardKind: 'powerup', resolution: 'task-then-persistent', completionInstruction: 'Report when every lemon is attached; the app will continue tracking them.' }),
  curse('luxury-car', 'Curse of the Luxury Car', 'Seekers must photograph a more expensive car than the hider.', { aiPlayable: false, blocksQuestions: true, castingInstruction: 'The hider must take a qualifying car photo.' }),
  curse('mediocre-travel-agent', 'Curse of the Mediocre Travel Agent', 'Seekers must visit the selected nearby destination, stay five minutes, take at least three photos, and bring a souvenir.', { uncertainCasting: true, blocksQuestions: true, failureBonusMinutes: 30, failureInstruction: 'Report if the souvenir is lost before it can be given to the hider.', castingInstruction: 'Seekers must be off transit, and the destination must be within 0.25 mile and farther from the hider than their current location.', resolution: 'task-then-persistent', completionInstruction: 'Report after the visit, photos, and souvenir are complete; the app will continue tracking the souvenir.' }),
  curse('overflowing-chalice', 'Curse of the Overflowing Chalice', 'The hider draws, but does not keep, one additional card on each of the next three rewarded questions.', { discardCost: 1, resolution: 'question-counter', completionInstruction: 'The effect clears automatically after three rewarded questions.' }),
  curse('ransom-note', 'Curse of the Ransom Note', 'The next question must be composed from letters cut out of printed material.', { aiPlayable: false, blocksQuestions: true, castingInstruction: 'Spell “ransom note” from printed cutouts without using the card.' }),
  curse('right-turn', 'Curse of the Right Turn', 'For 20 minutes, seekers may only turn right at street intersections, except for the printed dead-end exception.', { discardCost: 1, resolution: 'timed', smallDurationMinutes: 20, completionInstruction: 'The effect expires automatically after 20 minutes.' }),
  curse('spotty-memory', 'Curse of Spotty Memory', 'A random question category is disabled at all times and rerolled after each question for the rest of the run.', { discardCost: 1, discardKind: 'time-bonus', resolution: 'persistent', completionInstruction: 'This restriction remains active for the rest of the game.' }),
  curse('bird-guide', 'Curse of the Bird Guide', 'The hider and seekers must film a bird continuously for matching durations.', { aiPlayable: false, blocksQuestions: true, castingInstruction: 'The hider must continuously film a bird first.' }),
  curse('unguided-tourist', 'Curse of the Unguided Tourist', 'Seekers must find the displayed unzoomed Street View scene within 500 feet of their submitted location before using transportation or asking another question.', { uncertainCasting: true, blocksQuestions: true, blocksTransit: true, castingInstruction: 'Seekers must currently be outside.', completionInstruction: 'Find the displayed scene in person and report the curse cleared.' }),
  curse('u-turn', 'Curse of the U-Turn', 'Seekers must disembark their current transportation at the next station.', { uncertainCasting: true, castingInstruction: 'Seekers must be heading away from the hider, and the next station must have another form of transit within 30 minutes.', completionInstruction: 'Disembark at the next station, then report the curse cleared.' }),
  curse('urban-explorer', 'Curse of the Urban Explorer', 'For the rest of the run, seekers cannot ask questions while on transit or inside a transit station.', { discardCost: 2, resolution: 'persistent', completionInstruction: 'This restriction remains active for the rest of the game.' }),
  curse('water-weight', 'Curse of Water Weight', 'Seekers must acquire at least two liters of liquid per seeker before asking another question and carry it for the rest of the run.', { uncertainCasting: true, blocksQuestions: true, failureBonusMinutes: 30, failureInstruction: 'Report if the liquid is lost or abandoned after acquisition.', castingInstruction: 'Seekers must be within 1,000 feet (300 meters) of a body of water.', resolution: 'task-then-persistent', completionInstruction: 'Report when the liquid has been acquired; the app will continue tracking it.' }),
  curse('zoologist', 'Curse of the Zoologist', 'Seekers must photograph a wild animal from the same category as the hider’s animal.', { aiPlayable: false, blocksQuestions: true, castingInstruction: 'The hider must take a qualifying wild-animal photo.' }),
] satisfies CardDefinition[]).map((definition) => [definition.id, definition])) as Record<CardId, CardDefinition>;

export const UNPLAYABLE_AI_CURSES = new Set<CardId>(['cairn', 'luxury-car', 'ransom-note', 'bird-guide', 'zoologist']);

export type CardInstanceId = `${CardId}#${number}`;

export type DeckState = {
  drawPile: CardInstanceId[];
  hand: CardInstanceId[];
  discardPile: CardInstanceId[];
  usedPile: CardInstanceId[];
  maxHandSize: number;
};

export function cardIdFromInstance(instance: CardInstanceId) {
  return instance.slice(0, instance.lastIndexOf('#')) as CardId;
}

export function cardForInstance(instance: CardInstanceId) {
  return CARD_CATALOG[cardIdFromInstance(instance)];
}

export function createDeck(random: () => number = Math.random): DeckState {
  const cards = Object.values(CARD_CATALOG).flatMap((definition) =>
    Array.from({ length: definition.count }, (_, index) => `${definition.id}#${index + 1}` as CardInstanceId));
  for (let index = cards.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [cards[index], cards[swap]] = [cards[swap], cards[index]];
  }
  return { drawPile: cards, hand: [], discardPile: [], usedPile: [], maxHandSize: 6 };
}

export function fallbackCardRank(instance: CardInstanceId) {
  const card = cardForInstance(instance);
  if (card.kind === 'time-bonus') {
    const minutes = card.smallMinutes ?? 0;
    return minutes >= 6 ? 1_000 + minutes : 800 + minutes;
  }
  if (card.id === 'veto' || card.id === 'randomize') return 950;
  if (card.kind === 'powerup') return card.id === 'expand-hand' ? 850 : card.id === 'duplicate' ? 800 : 700;
  if (!card.aiPlayable) return 0;
  return card.uncertainCasting ? 250 : 900;
}

export type DrawGroupResult = { drawn: CardInstanceId[]; kept: CardInstanceId[]; discarded: CardInstanceId[] };

export function drawReward(
  deck: DeckState,
  drawCount: number,
  keepCount: number,
  repetitions = 1,
  choose?: (drawn: CardInstanceId[], keep: number, group: number) => CardInstanceId[],
) {
  const groups: DrawGroupResult[] = [];
  for (let group = 0; group < repetitions; group += 1) {
    const drawn = deck.drawPile.splice(0, drawCount);
    const requested = choose?.(drawn, keepCount, group) ?? [...drawn].sort((a, b) => fallbackCardRank(b) - fallbackCardRank(a)).slice(0, keepCount);
    const valid = requested.filter((instance, index) => drawn.includes(instance) && requested.indexOf(instance) === index).slice(0, keepCount);
    const kept = valid.length === Math.min(keepCount, drawn.length)
      ? valid
      : [...drawn].sort((a, b) => fallbackCardRank(b) - fallbackCardRank(a)).slice(0, keepCount);
    const discarded = drawn.filter((instance) => !kept.includes(instance));
    deck.hand.push(...kept);
    deck.discardPile.push(...discarded);
    groups.push({ drawn, kept, discarded });
  }
  enforceHandLimit(deck);
  return groups;
}

export function enforceHandLimit(deck: DeckState) {
  if (deck.hand.length <= deck.maxHandSize) return [];
  const excess = deck.hand.length - deck.maxHandSize;
  const discarded = [...deck.hand].sort((a, b) => fallbackCardRank(a) - fallbackCardRank(b)).slice(0, excess);
  deck.hand = deck.hand.filter((instance) => !discarded.includes(instance));
  deck.discardPile.push(...discarded);
  return discarded;
}

export function handTimeBonusMinutes(deck: DeckState) {
  return deck.hand.reduce((total, instance) => {
    const card = cardForInstance(instance);
    return total + (card.kind === 'time-bonus' ? card.smallMinutes ?? 0 : 0);
  }, 0);
}

export function deckCatalogCount() {
  return Object.values(CARD_CATALOG).reduce((total, definition) => total + definition.count, 0);
}
