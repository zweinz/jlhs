import type { QuestionKind } from './types';

export type QuestionDefinition = {
  label: string;
  help: string;
  notes: string[];
  sourceUrl?: string;
  drawInstruction?: string;
  baseDrawCount?: number;
  timeLimit?: string;
};

const manualNote = 'Manual map operation supplied for SF play; this is not a standalone rulebook card.';
const commonQuestionNotes = [
  'If the answer misses its time limit, the hider’s clock pauses until it is answered and the hider receives no cards.',
  'Repeating an already-used question multiplies its card cost: perform each draw/keep separately rather than pooling the draws.',
];

export const QUESTION_DEFINITIONS: Record<QuestionKind, QuestionDefinition> = {
  radar: {
    label: 'Radar',
    help: 'Keep points inside or outside a circle around the seeker pin.',
    notes: [
      ...commonQuestionNotes,
      'The answer is based on the hider’s current location, not whether any part of the hiding zone overlaps the circle.',
      'Rulebook distances: ¼, ½, 1, 3, 5, 10, 25, 50, or 100 miles; use a distance appropriate to the map.',
      'Game modification: custom radar distances are allowed when the players agree on the distance.',
      'The hider answers yes or no.',
    ],
    drawInstruction: 'Draw 2, keep 1',
    baseDrawCount: 2,
    timeLimit: '5 minutes',
    sourceUrl: 'https://www.lifack.ch/docs/seeking/radar_questions/',
  },
  thermometer: {
    label: 'Thermometer',
    help: 'Split the map by which of two seeker pins is closer to the hider.',
    notes: [
      ...commonQuestionNotes,
      'The seeker sends a starting pin, travels the stated minimum crow-flies distance, then sends an ending pin.',
      'Hotter means the ending pin is closer to the hider; otherwise the answer is colder.',
      'Distances: ½ and 3 miles for all games; add 10 miles for medium/large and 50 miles for large.',
      'Game modification: custom thermometer distances are allowed when the players agree on the distance.',
    ],
    drawInstruction: 'Draw 2, keep 1',
    baseDrawCount: 2,
    timeLimit: '5 minutes',
    sourceUrl: 'https://www.lifack.ch/docs/seeking/thermometer_questions/',
  },
  measuring: {
    label: 'Measuring: nearest category',
    help: 'Compare each point’s nearest-category distance with the seeker’s.',
    notes: [
      ...commonQuestionNotes,
      'The question is “Compared to me, are you closer to or further from ___?”',
      'The hider answers only closer, further, or null; they do not name their nearest category location.',
      'Locations outside the agreed map are ignored; answer null if none exist in the map.',
      'Use the same mapping app on both teams. The SF POI snapshot applies the shared Google Maps criteria; seekers should clarify any disputed category pin.',
      'Rail stations include light rail, heavy rail, metros, and subways.',
    ],
    drawInstruction: 'Draw 3, keep 1',
    baseDrawCount: 3,
    timeLimit: '5 minutes',
    sourceUrl: 'https://www.lifack.ch/docs/seeking/measuring_questions/',
  },
  coastline: {
    label: 'Measuring: coastline',
    help: 'Compare distance to the nearer Bay or Pacific coastline from the seeker’s shared pin.',
    notes: [
      ...commonQuestionNotes,
      'This legacy shortcut is retained for old shared URLs. New coastline questions are created under Measuring.',
      'The seeker’s shared pin is the comparison point; the map center is never used as a substitute.',
      'The SF modification uses whichever is nearer: the Bay or the Pacific Ocean.',
      'The rulebook treats coastline as land meeting an ocean, great lake, or a sufficiently wide water connection to one, and notes that exact precision is unnecessary.',
      'The straight southern county boundary is excluded from the DataSF shoreline geometry.',
    ],
    drawInstruction: 'Draw 3, keep 1',
    baseDrawCount: 3,
    timeLimit: '5 minutes',
    sourceUrl: 'https://www.lifack.ch/docs/seeking/measuring_questions/',
  },
  'matching-region': {
    label: 'Matching',
    help: 'Keep the nearest-POI region matching the seeker’s source POI.',
    notes: [
      ...commonQuestionNotes,
      'The hider answers whether their nearest item in the selected category is the same as the seeker’s nearest item.',
      'The hider answers only yes, no, or null; they do not name or describe the hider-side matching value.',
      'Locations outside the agreed map are ignored; answer null if none exist in the map.',
      'Use the same mapping app on both teams. The SF POI snapshot applies the shared Google Maps criteria; seekers should clarify any disputed category pin.',
      'For the transit-line variant, the seeker must be on moving transit and the service must actually stop at the hider station; passing express service does not match.',
      'Map-icon categories include mountains, parks, and other agreed POIs.',
    ],
    drawInstruction: 'Draw 3, keep 1',
    baseDrawCount: 3,
    timeLimit: '5 minutes',
    sourceUrl: 'https://www.lifack.ch/docs/seeking/matching_questions/',
  },
  tentacle: {
    label: 'Tentacles',
    help: 'Use a nearby source POI’s nearest region and reach circle, or exclude every reachable POI.',
    notes: [
      ...commonQuestionNotes,
      'Tentacle questions are not part of a standard small game; use them in SF only if your group has agreed to add them.',
      'The hider names the category item they are nearest to, provided it is within the stated reach; otherwise answer “not within reach.”',
      'Medium-game cards use museums, libraries, movie theaters, or hospitals within 1 mile.',
      'Large games also add metro lines, zoos, aquariums, and amusement parks within 15 miles.',
      'The hider names the answer and may use a map. The response does not reveal the hider’s exact location.',
    ],
    drawInstruction: 'Draw 4, keep 2',
    baseDrawCount: 4,
    timeLimit: '5 minutes',
    sourceUrl: 'https://www.lifack.ch/docs/seeking/tentacle_questions/',
  },
  'photo-reference': {
    label: 'Photo (reference only)',
    help: 'Record a photo question without changing the feasible polygon.',
    notes: [
      ...commonQuestionNotes,
      'Photo questions require the hider to take a new photo after the question is asked, from their current location unless the card says otherwise.',
      'Game modification: every medium-game photo card is allowed in this game.',
      'Use the phone’s normal aspect ratio. “I cannot answer” is valid when the requested subject does not exist or is inaccessible in the hiding zone.',
      'Google Street View cannot be used to assess photos or verify stations from afar.',
      'The image must follow the card’s framing/content rules; ambiguity should be resolved consistently by the players.',
      'Photos do not create a deterministic geographic polygon, so this card is recorded but not shaded.',
    ],
    drawInstruction: 'Draw 1, keep 1',
    baseDrawCount: 1,
    timeLimit: '10 minutes for the SF small game',
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
  'matching-region',
  'tentacle',
  'photo-reference',
];

export const orderedRuleNotes = (
  kind: QuestionKind,
  questionNotes: string[],
  subjectNotes: string[] = [],
) => kind === 'photo-reference'
  ? [...subjectNotes, ...questionNotes]
  : [...questionNotes, ...subjectNotes];
