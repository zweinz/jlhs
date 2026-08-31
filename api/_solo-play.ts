import { CARD_CATALOG, cardIdFromInstance, type CardInstanceId } from '../src/cards';
import { distanceMeters } from '../src/solo';
import { addDecision, duplicatePostAnswerTarget, effectiveCardIdForPlay, legalPostAnswerCards, playMoveCard, playPostAnswerCard, preferredDuplicatePlay } from './_solo-cards';
import { groundedPlace } from './_solo-gemini';
import { panoramaAt } from './_solo-google';
import { seal, type PhotoAsset, type SecretSoloSession } from './_solo-session';

type ResolvedPlay = { played: boolean; announcements: string[] };

async function resolveSoloCard(session: SecretSoloSession, selected: CardInstanceId): Promise<ResolvedPlay> {
  const announcements: string[] = [];
  const playedId = effectiveCardIdForPlay(session, selected);
  const result = playedId === 'move'
    ? await playMoveCard(session, selected)
    : playPostAnswerCard(session, selected);
  if (result.announcement) announcements.push(result.announcement);
  if (result.played && (playedId === 'distant-cuisine' || playedId === 'mediocre-travel-agent')) {
    const center = playedId === 'distant-cuisine' ? session.station.position : session.lastSeekerPosition!;
    const place = await groundedPlace(session, playedId, center);
    const validPlace = place && distanceMeters(place.position, center) <= (playedId === 'distant-cuisine' ? session.stationZoneMiles : 0.25) * 1609.344 ? place : undefined;
    const effect = session.activeEffects?.find((candidate) => candidate.cardInstance === selected);
    if (effect && validPlace) {
      effect.placeName = validPlace.name;
      effect.proposedPosition = validPlace.position;
      effect.citationUrl = validPlace.citationUrl;
      if (playedId === 'mediocre-travel-agent' && session.lastSeekerPosition) {
        session.publicEvidence = [...(session.publicEvidence ?? []), {
          id: effect.id,
          kind: 'closer-to',
          label: `${effect.name}: the destination is farther from Xeno than the seekers were`,
          nearer: session.lastSeekerPosition,
          farther: validPlace.position,
          placeName: validPlace.name,
          positionRevision: session.positionRevision ?? 0,
        }];
      }
      effect.detail = playedId === 'distant-cuisine'
        ? `Reference restaurant: ${validPlace.name}. Cuisine country: ${validPlace.country}. Seekers need a restaurant whose country is at least as far from San Francisco. Xeno has not moved.`
        : `Vacation destination: ${validPlace.name}. Stay at least five minutes, send three photos, and obtain a souvenir.`;
    } else if (effect) {
      session.activeEffects = session.activeEffects?.filter((candidate) => candidate.id !== effect.id);
      session.deck.usedPile = session.deck.usedPile.filter((instance) => instance !== effect.cardInstance);
      session.deck.discardPile.push(effect.cardInstance);
      addDecision(session, `${effect.name} could not be grounded and was discarded; ${cardIdFromInstance(selected) === 'duplicate' ? 'the normal card allowance is unchanged' : 'its curse cooldown remains'}.`);
      announcements.push(`${effect.name} could not find a valid grounded destination and had no effect.`);
    }
  } else if (result.played && playedId === 'unguided-tourist') {
    const effect = session.activeEffects?.find((candidate) => candidate.cardInstance === selected);
    const panorama = session.lastSeekerPosition ? await panoramaAt(session.lastSeekerPosition) : null;
    if (effect && panorama && distanceMeters(panorama.position, session.lastSeekerPosition!) <= 500 * 0.3048) {
      const photoAsset: PhotoAsset = {
        kind: 'solo-photo', version: 1, expiresAt: session.expiresAt,
        panoramaId: panorama.id, heading: crypto.getRandomValues(new Uint16Array(1))[0] % 360, pitch: 0, fov: 120,
      };
      effect.imageUrl = `/api/solo/photo?token=${encodeURIComponent(await seal(photoAsset))}`;
      effect.detail = 'This unzoomed, horizon-level outdoor Street View scene is within 500 feet of the latest submitted seeker position.';
    } else if (effect) {
      session.activeEffects = session.activeEffects?.filter((candidate) => candidate.id !== effect.id);
      session.deck.usedPile = session.deck.usedPile.filter((candidate) => candidate !== effect.cardInstance);
      session.deck.discardPile.push(effect.cardInstance);
      addDecision(session, `${effect.name} could not obtain a qualifying nearby Street View scene and was discarded; ${cardIdFromInstance(selected) === 'duplicate' ? 'the normal card allowance is unchanged' : 'its curse cooldown remains'}.`);
      announcements.push(`${effect.name} could not obtain a qualifying nearby Street View scene and had no effect.`);
    }
  }
  return { played: result.played, announcements };
}

/** One ordinary card plus any physical Duplicate cards, revalidated after each play. */
export async function playSoloCards(
  session: SecretSoloSession,
  options: { selected?: CardInstanceId; allowNormal?: boolean } = {},
  resolve: (session: SecretSoloSession, selected: CardInstanceId) => Promise<ResolvedPlay> = resolveSoloCard,
) {
  const announcements: string[] = [];
  if (session.pausedAt || session.phase === 'found' || session.phase === 'gave-up') return announcements;
  const selectedIsCopy = options.selected && cardIdFromInstance(options.selected) === 'duplicate';
  let normalCard = selectedIsCopy ? duplicatePostAnswerTarget(session, options.selected!) : options.selected;
  let selectedCopy = selectedIsCopy ? options.selected : undefined;
  let normalAvailable = options.allowNormal !== false;
  // The deck contains two Duplicates. This also covers copies drawn by this sequence
  // without allowing an unbounded chain or a second ordinary card.
  for (let count = 0; count < 1 + CARD_CATALOG.duplicate.count; count += 1) {
    const legal = legalPostAnswerCards(session);
    const normal = normalAvailable && normalCard && legal.includes(normalCard) ? normalCard : undefined;
    const discardsHand = normal && ['move', 'drained-brain'].includes(cardIdFromInstance(normal));
    const copy = selectedCopy && legal.includes(selectedCopy) ? selectedCopy
      : !discardsHand ? preferredDuplicatePlay(session) : undefined;
    const next = copy ?? normal;
    if (!next) break;
    const result = await resolve(session, next);
    announcements.push(...result.announcements);
    selectedCopy = undefined;
    if (!result.played) break;
    if (cardIdFromInstance(next) !== 'duplicate') {
      normalAvailable = false;
      normalCard = undefined;
    }
  }
  return announcements;
}
