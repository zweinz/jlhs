import type { QuestionKind } from './types';

export type QuestionDefinition = {
  label: string;
  help: string;
  notes: string[];
  sourceUrl?: string;
  reward?: string;
  timeLimit?: string;
};

const manualNote = 'Manual map operation supplied for SF play; this is not a standalone rulebook card.';

export const QUESTION_DEFINITIONS: Record<QuestionKind, QuestionDefinition> = {
  radar: {
    label: 'Radar',
    help: 'Keep points inside or outside a circle around the seeker pin.',
    notes: [
      'The answer is based on the hider’s current location, not whether any part of the hiding zone overlaps the circle.',
      'Rulebook distances: ¼, ½, 1, 3, 5, 10, 25, 50, or 100 miles; use a distance appropriate to the map.',
      'The hider answers yes or no. Seekers draw 2 cards and keep 1.',
    ],
    reward: 'Reveal 1 card and draw 1 card',
    timeLimit: 'No answer timer listed',
    sourceUrl: 'https://www.lifack.ch/docs/seeking/radar_questions/',
  },
  thermometer: {
    label: 'Thermometer',
    help: 'Split the map by which of two seeker pins is closer to the hider.',
    notes: [
      'The seeker sends a starting pin, travels the stated minimum crow-flies distance, then sends an ending pin.',
      'Hotter means the ending pin is closer to the hider; otherwise the answer is colder.',
      'Distances: ½ and 3 miles for all games; add 10 miles for medium/large and 50 miles for large.',
      'Seekers draw 2 cards and keep 1.',
    ],
    reward: 'Reveal 1 card and draw 1 card',
    timeLimit: 'No answer timer listed',
    sourceUrl: 'https://www.lifack.ch/docs/seeking/thermometer_questions/',
  },
  measuring: {
    label: 'Measuring: nearest category',
    help: 'Compare each point’s nearest-category distance with the seeker’s.',
    notes: [
      'The question is “Compared to me, are you closer to or further from ___?”',
      'Locations outside the agreed map are ignored; answer null if none exist in the map.',
      'Rail stations include light rail, heavy rail, metros, and subways.',
      'Seekers draw 3 cards and keep 1.',
    ],
    reward: 'Reveal 1 card and draw 1 card',
    timeLimit: 'No answer timer listed',
    sourceUrl: 'https://www.lifack.ch/docs/seeking/measuring_questions/',
  },
  coastline: {
    label: 'Measuring: coastline',
    help: 'Compare distance to the SF mainland shoreline with the fixed SF map center.',
    notes: [
      'This SF implementation uses the center of the working map as the seeker comparison point, as requested.',
      'The rulebook treats coastline as land meeting an ocean, great lake, or a sufficiently wide water connection to one, and notes that exact precision is unnecessary.',
      'The straight southern county boundary is excluded from the DataSF shoreline geometry.',
      'Seekers draw 3 cards and keep 1.',
    ],
    reward: 'Reveal 1 card and draw 1 card',
    timeLimit: 'No answer timer listed',
    sourceUrl: 'https://www.lifack.ch/docs/seeking/measuring_questions/',
  },
  'matching-region': {
    label: 'Matching',
    help: 'Keep the nearest-POI region matching the seeker’s source POI.',
    notes: [
      'The hider answers whether their nearest item in the selected category is the same as the seeker’s nearest item.',
      'Locations outside the agreed map are ignored; answer null if none exist in the map.',
      'For the transit-line variant, the seeker must be on moving transit and the service must actually stop at the hider station; passing express service does not match.',
      'Map-icon categories include mountains, parks, and other agreed POIs. Seekers draw 3 cards and keep 1.',
    ],
    reward: 'Reveal 1 card and draw 1 card',
    timeLimit: 'No answer timer listed',
    sourceUrl: 'https://www.lifack.ch/docs/seeking/matching_questions/',
  },
  tentacle: {
    label: 'Tentacles',
    help: 'Use a nearby source POI’s nearest region and reach circle, or exclude every reachable POI.',
    notes: [
      'The hider names the category item they are nearest to, provided it is within the stated reach; otherwise answer “not within reach.”',
      'Medium-game cards use museums, libraries, movie theaters, or hospitals within 1 mile.',
      'Large games also add metro lines, zoos, aquariums, and amusement parks within 15 miles.',
      'The hider has 5 minutes. Seekers draw 4 cards and keep 2.',
    ],
    reward: 'Reveal 2 cards and draw 2 cards',
    timeLimit: '5 minutes',
    sourceUrl: 'https://www.lifack.ch/docs/seeking/tentacle_questions/',
  },
  'photo-reference': {
    label: 'Photo (reference only)',
    help: 'Record a photo question without changing the feasible polygon.',
    notes: [
      'Photo questions require the hider to take a new photo after the question is asked, from their current location unless the card says otherwise.',
      'The image must follow the card’s framing/content rules; ambiguity should be resolved consistently by the players.',
      'Photos do not create a deterministic geographic polygon, so this card is recorded but not shaded.',
    ],
    sourceUrl: 'https://www.lifack.ch/docs/seeking/photo_questions/',
  },
  radius: { label: 'Manual radius', help: 'Keep an area inside or outside a measured radius.', notes: [manualNote] },
  direction: { label: 'Manual direction', help: 'Keep a half-plane north, south, east, or west of a pin.', notes: [manualNote] },
  closer: { label: 'Manual closer than', help: 'Keep points within the answered comparison radius.', notes: [manualNote] },
  farther: { label: 'Manual farther than', help: 'Keep points beyond the answered comparison radius.', notes: [manualNote] },
  intersection: { label: 'Manual intersection', help: 'Intersect the feasible area with a radius.', notes: [manualNote] },
  exclusion: { label: 'Manual exclusion', help: 'Remove a radius from the feasible area.', notes: [manualNote] },
};

export const PRIMARY_QUESTION_KINDS: QuestionKind[] = [
  'radar',
  'thermometer',
  'measuring',
  'coastline',
  'matching-region',
  'tentacle',
  'photo-reference',
];
