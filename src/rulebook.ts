export type SubjectStatus = 'in-play' | 'out-of-play';
export type SubjectSupport = 'exact' | 'approximate' | 'reference' | 'not-mapped';

export type RulebookSubject = {
  id: string;
  label: string;
  status: SubjectStatus;
  support: SubjectSupport;
  notes: string[];
};

const excluded = (id: string, label: string, reason: string): RulebookSubject => ({
  id,
  label,
  status: 'out-of-play',
  support: 'not-mapped',
  notes: [reason],
});

export const MATCHING_SUBJECTS: RulebookSubject[] = [
  excluded('commercial-airport', 'Commercial airport', 'Not in the SF deck: no commercial airport is inside the game map.'),
  { id: 'transit-route', label: 'Transit line', status: 'in-play', support: 'exact', notes: ['Ask whether the moving transit service the seekers are currently riding actually stops at the hider’s chosen hiding station.', 'There is no distance measurement. Limited/Rapid service counts only its scheduled stops.', 'Uses the SF game sheet’s station associations plus SFMTA GTFS stop schedules.'] },
  { id: 'station-name-length', label: 'Station’s name length', status: 'in-play', support: 'exact', notes: ['Compare the character count of each player’s nearest station.', 'Exclude the word “Station” and periods. Include spaces, hyphens, ampersands, slashes, and other characters.'] },
  { id: 'street-path', label: 'Street or path', status: 'in-play', support: 'approximate', notes: ['A street/path ends when its name changes, including directional suffix changes. An unnamed path starts/ends at each intersection.', 'Uses the nearest named DataSF street centerline on an approximately 300-foot grid. Park paths, unnamed paths, and ambiguous map labels require player judgment.'] },
  excluded('admin-1', '1st administrative division', 'Not in the SF deck.'),
  excluded('admin-2', '2nd administrative division', 'Not in the SF deck.'),
  excluded('admin-3', '3rd administrative division', 'Not in the SF deck.'),
  { id: 'supervisor-district', label: '4th administrative division', status: 'in-play', support: 'exact', notes: ['For SF, this means current Supervisorial Districts D1–D11.'] },
  { id: 'mountain', label: 'Mountain', status: 'in-play', support: 'exact', notes: ['Uses the SF-modified list of 16 hills at least 400 feet high.'] },
  { id: 'landmass', label: 'Landmass', status: 'in-play', support: 'exact', notes: ['A landmass is a contiguous piece of land not broken by a waterway.', 'For this SF deck the three answers are Treasure Island, Strawberry Hill, and everything else in San Francisco.'] },
  { id: 'dog-park', label: 'Park (dog park)', status: 'in-play', support: 'exact', notes: ['SF replaces “park” with the spreadsheet-defined dog parks.'] },
  excluded('amusement-park', 'Amusement park', 'Not in the SF deck: no qualifying Google Maps category exists inside the boundary.'),
  excluded('zoo', 'Zoo', 'Not in the SF matching deck: only one qualifying zoo makes the answer uninformative.'),
  excluded('aquarium', 'Aquarium', 'Not in the SF matching deck: the two aquariums make this question too powerful.'),
  { id: 'golf-course', label: 'Golf course', status: 'in-play', support: 'exact', notes: ['Outdoor golf courses count; miniature golf and driving ranges do not. Measure from the map pin.', 'Uses the eight SF-modified qualifying golf courses.'] },
  { id: 'museum', label: 'Museum', status: 'in-play', support: 'exact', notes: ['Uses the curated SF spreadsheet list and its Google-category/review/accessibility criteria.'] },
  { id: 'movie-theater', label: 'Movie theater', status: 'in-play', support: 'exact', notes: ['Uses qualifying indoor Google Maps movie-theater pins with more than five reviews.'] },
  { id: 'hospital', label: 'Hospital', status: 'in-play', support: 'exact', notes: ['Uses the curated SF hospital list; clinics and veterinary hospitals do not count.'] },
  { id: 'library', label: 'Library', status: 'in-play', support: 'exact', notes: ['Uses SFPL branches plus the Treasure Island kiosk; school, private, and sidewalk libraries do not count.'] },
  { id: 'foreign-consulate', label: 'Foreign consulate', status: 'in-play', support: 'exact', notes: ['Uses consulates general plus TECO; honorary consulates do not count.'] },
];

export const MEASURING_SUBJECTS: RulebookSubject[] = [
  excluded('commercial-airport', 'Commercial airport', 'Not in the SF deck: no commercial airport is inside the game map.'),
  excluded('high-speed-train-line', 'High-speed train line', 'Not in the SF deck.'),
  { id: 'rail-station', label: 'Rail station', status: 'in-play', support: 'exact', notes: ['Uses the SF-modified spreadsheet list: BART and Caltrain plus the specified high-platform/subway Muni Metro stations.', 'It excludes ferries, buses, cable cars, F Market stops, and low-level Muni boarding stops.'] },
  excluded('international-border', 'International border', 'Not in the SF deck.'),
  excluded('admin-1-border', '1st administrative-division border', 'Not in the SF deck.'),
  excluded('admin-2-border', '2nd administrative-division border', 'Not in the SF deck.'),
  { id: 'sea-level', label: 'Sea level', status: 'in-play', support: 'approximate', notes: ['This compares the players’ altitude: “closer” means lower elevation above sea level; “farther” means higher elevation.', 'The rulebook suggests checking the phone compass and warns that its altitude may be inaccurate.', 'The mapped estimate uses an open terrain grid at approximately 300-foot cells; use the hider helper’s value as a guide, not a survey reading.'] },
  { id: 'body-of-water', label: 'Body of water', status: 'in-play', support: 'approximate', notes: ['Any named body of water in the mapping app counts; pools do not. The SF modification additionally requires it to appear blue on Google Maps.', 'The mapped estimate uses DataSF named inland water bodies plus the Bay/Pacific shoreline; confirm any Google Maps display discrepancy.'] },
  { id: 'coastline', label: 'Coastline', status: 'in-play', support: 'approximate', notes: ['Compare from the seeker’s shared pin—not the map center.', 'Base definition: land meeting an ocean, great lake, or water connected to one by a channel never less than one mile wide; players should resolve edge-case precision together.', 'SF modification: despite the Golden Gate’s narrowest width, use whichever is nearer—the Bay or the Pacific Ocean.', 'The displayed shoreline is lightly simplified for mobile performance, consistent with the rulebook’s warning not to rely on coastline precision.'] },
  { id: 'mountain', label: 'Mountain', status: 'in-play', support: 'exact', notes: ['Uses the SF-modified list of 16 hills at least 400 feet high.'] },
  { id: 'dog-park', label: 'Park (dog park)', status: 'in-play', support: 'exact', notes: ['SF replaces “park” with the spreadsheet-defined dog parks.'] },
  excluded('amusement-park', 'Amusement park', 'Not in the SF deck.'),
  excluded('zoo', 'Zoo', 'Not in the SF deck.'),
  { id: 'aquarium', label: 'Aquarium', status: 'in-play', support: 'exact', notes: ['The measuring version remains in play even though aquarium matching is excluded.'] },
  { id: 'golf-course', label: 'Golf course', status: 'in-play', support: 'exact', notes: ['Uses the eight qualifying SF golf courses.'] },
  { id: 'museum', label: 'Museum', status: 'in-play', support: 'exact', notes: ['Uses the curated SF spreadsheet museum list.'] },
  { id: 'movie-theater', label: 'Movie theater', status: 'in-play', support: 'exact', notes: ['Uses the curated SF spreadsheet movie-theater list.'] },
  { id: 'hospital', label: 'Hospital', status: 'in-play', support: 'exact', notes: ['Clinics and veterinary hospitals do not count.'] },
  { id: 'library', label: 'Library', status: 'in-play', support: 'exact', notes: ['School, private, and sidewalk libraries do not count.'] },
  { id: 'foreign-consulate', label: 'Foreign consulate', status: 'in-play', support: 'exact', notes: ['Honorary consulates do not count.'] },
];

const photo = (id: string, label: string, ...notes: string[]): RulebookSubject => ({ id, label, status: 'in-play', support: 'reference', notes });
const mediumPhoto = (id: string, label: string, ...notes: string[]) => photo(id, label, 'Game modification: all medium-game photo cards are allowed.', ...notes);

export const PHOTO_SUBJECTS: RulebookSubject[] = [
  photo('a-tree', 'A tree', 'The entire tree must be visible.'),
  photo('the-sky', 'The sky', 'Put the phone on the ground and shoot straight up with the default lens and no zoom.'),
  photo('you', 'You', 'Use selfie mode: phone perpendicular to the ground, arm fully extended, default lens, no zoom.'),
  photo('widest-street', 'Widest street', 'Include both sides of the street; background is not required.'),
  photo('tallest-structure-in-your-sightline', 'Tallest structure in your sightline', 'Use the tallest structure from the hider’s perspective, not objectively tallest.', 'Include the top and both sides; place the top in the upper third of the frame.'),
  photo('any-building-visible-from-station', 'Any building visible from station', 'Stand directly outside a station entrance; if there are multiple entrances, choose one.', 'Include the roof and both sides, with the top in the upper third. For an SF bus-stop hiding station, the building may be visible from either inbound or outbound stop.'),
  mediumPhoto('tallest-building-visible-from-station', 'Tallest building visible from station', 'Use the tallest building from the hider’s perspective, not the objectively tallest building.', 'Stand directly outside a station entrance; if there are multiple entrances, choose one. Include the roof and both sides, with the top in the upper third.', 'The station itself does not count unless an unrelated tall building sits above it.'),
  mediumPhoto('trace-nearest-street-path', 'Trace nearest street/path', 'The street/path must appear in the mapping app. Trace it intersection-to-intersection.', 'A screenshot may be blacked out around the street, or the route may be physically traced from the phone.'),
  mediumPhoto('two-buildings', 'Two buildings', 'Include each building’s bottom and no more than four stories.'),
  mediumPhoto('restaurant-interior', 'Restaurant interior', 'No zoom. Take the picture through the window from outside the restaurant.'),
  mediumPhoto('park', 'Park', 'No zoom; phone perpendicular to the ground; stand five feet from any obstruction.', 'SF counts Google categories Park, City Park, Memorial Park, or Dog Park with more than five reviews.'),
  mediumPhoto('grocery-store-aisle', 'Grocery-store aisle', 'No zoom. Stand at the end of the aisle and shoot directly down it.', 'SF counts Google categories Grocery Store, Supermarket, Convenience Store, Liquor Store, or Wine Store with more than five reviews.'),
  mediumPhoto('place-of-worship', 'Place of worship', 'Include a 5×5-foot section with three distinct, location-matchable elements.'),
  mediumPhoto('train-platform', 'Train platform', 'Include a 5×5-foot section with three distinct, location-matchable elements.'),
  excluded('half-mile-of-streets-traced', '½ mile of streets traced', 'Not added to the SF small-game deck.'),
  excluded('tallest-mountain-visible-from-station', 'Tallest mountain visible from station', 'Not added to the SF small-game deck.'),
  excluded('biggest-body-of-water-in-your-zone', 'Biggest body of water in your zone', 'Not added to the SF small-game deck.'),
  excluded('five-buildings', 'Five buildings', 'Not added to the SF small-game deck.'),
];

export const selectableSubjects = (subjects: RulebookSubject[]) =>
  subjects.filter((subject) => subject.status === 'in-play');

export const subjectById = (subjects: RulebookSubject[], id?: string) =>
  subjects.find((subject) => subject.id === id);
