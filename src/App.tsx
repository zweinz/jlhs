import { useEffect, useId, useMemo, useRef, useState } from 'react';
import * as turf from '@turf/turf';
import { setAllConstraintsEnabled, stationStatusesForAll, statusesForAll } from './bulkActions';
import { combineConstraints, excludedArea, manualReachArea, nearestPoi, partition, partitionLabelPosition, questionPreviewArea, stationIdsOverlappingArea } from './geometry';
import {
  CATEGORY_LABELS,
  PARTITION_CATEGORIES,
  pois,
  provenance,
  SF_BOUNDS,
  SF_CENTER,
  TENTACLE_CATEGORIES,
  type PoiCategory,
} from './data';
import { hiderAnswer } from './hider';
import { activeMapPartition, activePoiPartition, GEOGRAPHIC_PARTITIONS, selectMapPartition, VISIBLE_POI_PARTITIONS } from './layers';
import { createLongPressController } from './longPress';
import { persistManualReachBoundary, restoreManualReachBoundary } from './manualReachStorage';
import { googleMapsLinkForPlace, googleMapsLinkForPosition, resolveGoogleMapsLink } from './mapLinks';
import { formatQuestionDistance, missingQuestionFields, orderedRuleNotes, PRIMARY_QUESTION_KINDS, QUESTION_DEFINITIONS, questionIsReady, questionRequiresOrigin, questionRequiresTarget, RULEBOOK_DISTANCE_CHOICES } from './questions';
import {
  MATCHING_SUBJECTS,
  MEASURING_SUBJECTS,
  PHOTO_SUBJECTS,
  SF_MATCHING_SUBJECTS,
  selectableSubjects,
  type RulebookSubject,
} from './rulebook';
import {
  districtAt,
  elevationProvenance,
  landmassAt,
  nearestStreet,
  normalizedStationNameLength,
  rulebookAreaProvenance,
  sfLandmasses,
  streetProvenance,
  supervisorDistricts,
  zipCodeAreas,
  zipCodeAt,
} from './rulebookGeometry';
import { decodeState, encodeState, shareableState } from './share';
import {
  allowedHidingArea,
  bufferedNoHideZones,
  isHidingPositionAllowed,
  noHideZoneProvenance,
} from './noHideZones';
import {
  canonicalQuestionKey,
  cardsForQuestion,
  defaultSfDateTime,
  elapsedSoloSeconds,
  formatElapsedTime,
  keptCardsForQuestion,
  normalizeQuestionUses,
  publicSoloDisplayText,
  questionUseCounts,
  sfLocalDateTimeToIso,
  SOLO_PHOTO_SUBJECTS,
  askedChoiceLabel,
  answeredSoloConstraint,
  soloRevealMapFeatures,
  soloPhotoOptionLabel,
  soloStateForNewGame,
  type SoloClientSession,
  type SoloQuestionRecord,
  type SoloPublicCardState,
  type SoloStartResponse,
  vetoedSoloConstraint,
} from './solo';
import {
  coastlineProvenance,
  distanceToRoute,
  eligibleStationIds,
  filterStationsBySearch,
  primaryTransitRoutes,
  primaryTransitStationIds,
  routesForStation,
  shouldDisplayStationZone,
  stationIdsMatchingTransitQuestions,
  stationRouteProvenance,
  transitProvenance,
  transitRouteGeoJson,
  transitModeLabel,
  transitRouteLabel,
  transitRoutes,
  validStations,
} from './transit';
import type { Area, AreaDisplayMode, Constraint, Eligibility, ManualReachRegion, Position, QuestionKind, SharedState, TransitScope } from './types';
import { pathDistanceMiles, pathGeoJson } from './trace';
import './style.css';

const REGION_CATEGORIES: PoiCategory[] = [
  ...PARTITION_CATEGORIES,
  'game-valid-station',
  'rail-station',
  'aquarium',
];
const initialLayers = {
  ...Object.fromEntries(VISIBLE_POI_PARTITIONS.map((category) => [category, false])),
  'station-zones': false,
  'transit-routes': true,
  'other-transit-routes': false,
  'sticky-map': true,
  'supervisor-districts': false,
  'zip-codes': false,
  'no-hide-zones': false,
  landmasses: false,
  'partition-pins': true,
};
const initial: SharedState = {
  version: 2,
  constraints: [],
  layers: initialLayers,
  viewport: { center: SF_CENTER, zoom: 12 },
  mode: 'seeker',
  stationZoneMiles: 0.25,
  areaDisplayMode: 'excluded-red',
  transitScope: 'all',
  stationStatuses: {},
  routeStatuses: {},
  endGameActive: false,
};
const partitionColor = (index: number, total: number, offset = 0) =>
  `hsl(${Math.round((index * 360) / Math.max(1, total) + offset) % 360}, 62%, 39%)`;

function showMapLinkCard(
  infoWindow: google.maps.InfoWindow,
  map: google.maps.Map,
  position: Position,
  url: string,
  onMessage: (message: string) => void,
  title = 'Selected Google Maps place',
  onClose?: () => void,
) {
  const header = document.createElement('strong');
  header.textContent = title;
  const content = document.createElement('div');
  content.className = 'map-place-card';
  const description = document.createElement('p');
  description.textContent = 'Open or copy a link to this exact place.';
  const actions = document.createElement('div');
  actions.className = 'map-place-actions';
  const open = document.createElement('a');
  open.href = url;
  open.target = '_blank';
  open.rel = 'noreferrer';
  open.textContent = 'Open in Google Maps';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy link';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
      onMessage('Place link copied.');
    } catch {
      onMessage('The place link could not be copied.');
    }
  });
  actions.append(open, copy);
  content.append(description, actions);
  google.maps.event.clearListeners(infoWindow, 'closeclick');
  if (onClose) infoWindow.addListener('closeclick', onClose);
  infoWindow.setOptions({ position, headerContent: header, content, ariaLabel: 'Selected Google Maps place' });
  infoWindow.open({ map });
}
const measuringChoices = selectableSubjects(MEASURING_SUBJECTS);
const matchingChoices = SF_MATCHING_SUBJECTS;
const photoChoices = selectableSubjects(PHOTO_SUBJECTS);
const soloPhotoChoices: RulebookSubject[] = SOLO_PHOTO_SUBJECTS.map((subject) => ({
  ...subject,
  label: soloPhotoOptionLabel(subject),
  status: 'in-play',
  support: subject.help.startsWith('Unavailable') ? 'not-mapped' : subject.help.startsWith('Supported') || subject.help.startsWith('Easter egg') ? 'exact' : 'approximate',
  notes: [subject.help, 'Solo house rule: checked-in POIs or Google Places choose eligible targets; Street View approximates framing without visually verifying the returned image.'],
}));

const SOLO_STORAGE_KEY = 'sf-hiding-area-solo-v3';

function currentConfigKey() {
  return new URLSearchParams(location.search).get('config') ?? '';
}

function restoredSolo(): SoloClientSession | undefined {
  try {
    const value = localStorage.getItem(SOLO_STORAGE_KEY);
    if (!value) return undefined;
    return JSON.parse(value) as SoloClientSession;
  } catch {
    return undefined;
  }
}

const initialSolo = restoredSolo();

let googleMapsPromise: Promise<typeof google.maps> | null = null;

function loadGoogleMaps(key: string) {
  if (window.google?.maps) return Promise.resolve(window.google.maps);
  if (googleMapsPromise) return googleMapsPromise;
  googleMapsPromise = new Promise((resolve, reject) => {
    const callbackName = '__jlhsGoogleMapsLoaded';
    const callbackWindow = window as typeof window & Record<string, unknown>;
    const script = document.createElement('script');
    callbackWindow[callbackName] = () => {
      delete callbackWindow[callbackName];
      resolve(window.google.maps);
    };
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=${callbackName}`;
    script.async = true;
    script.onerror = () => {
      delete callbackWindow[callbackName];
      googleMapsPromise = null;
      reject(new Error('Google Maps could not load.'));
    };
    document.head.append(script);
  });
  return googleMapsPromise;
}

function restoredState() {
  try {
    const payload = new URLSearchParams(location.search).get('config');
    const restored = payload ? decodeState(payload) : initial;
    const localBoundary = restoreManualReachBoundary(localStorage, payload ?? '');
    return {
      ...restored,
      layers: selectMapPartition(restored.layers, activeMapPartition(restored.layers)),
      ...(localBoundary.matched ? { manualReachBoundary: localBoundary.boundary } : {}),
    };
  } catch {
    return initial;
  }
}

function insideSanFrancisco(position: Position) {
  return (
    position.lat >= SF_BOUNDS.south &&
    position.lat <= SF_BOUNDS.north &&
    position.lng >= SF_BOUNDS.west &&
    position.lng <= SF_BOUNDS.east
  );
}

type MapLinkFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onResolved: (position: Position) => void;
  onMessage: (message: string) => void;
};

function MapLinkField({ label, value, onChange, onResolved, onMessage }: MapLinkFieldProps) {
  const inputId = useId();
  const [busy, setBusy] = useState<'paste' | 'link' | 'location' | undefined>();
  const hasLink = value.trim().length > 0;
  const resolveAndSet = async (link: string, successMessage: string) => {
    const resolved = await resolveGoogleMapsLink(link);
    if (!insideSanFrancisco(resolved)) throw new Error('That pin is outside the San Francisco working bounds.');
    onResolved(resolved);
    onMessage(successMessage);
  };
  const paste = async () => {
    setBusy('paste');
    let pasted: string;
    try {
      if (!navigator.clipboard?.readText) throw new Error('Clipboard unavailable');
      pasted = (await navigator.clipboard.readText()).trim();
    } catch {
      onMessage('Clipboard access was blocked. Open “Enter or edit link manually,” press and hold the field, and choose Paste.');
      setBusy(undefined);
      return;
    }
    if (!pasted) {
      onMessage('The clipboard is empty. Copy a Google Maps link, then try again.');
      setBusy(undefined);
      return;
    }
    onChange(pasted);
    try {
      await resolveAndSet(pasted, `${label} pasted and set from Google Maps.`);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'Could not use the copied Google Maps link.');
    } finally {
      setBusy(undefined);
    }
  };
  const apply = async () => {
    try {
      setBusy('link');
      await resolveAndSet(value.trim(), `${label} set from Google Maps.`);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'Could not use that Google Maps link.');
    } finally {
      setBusy(undefined);
    }
  };
  const useCurrentLocation = () => {
    if (!navigator.geolocation) {
      onMessage('This browser does not provide geolocation. Paste a Google Maps link instead.');
      return;
    }
    setBusy('location');
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const resolved = { lat: coords.latitude, lng: coords.longitude };
        if (!insideSanFrancisco(resolved)) {
          onMessage('Your current position is outside the San Francisco working bounds.');
          setBusy(undefined);
          return;
        }
        onChange(googleMapsLinkForPosition(resolved));
        onResolved(resolved);
        onMessage(`${label} set from this device’s current location.`);
        setBusy(undefined);
      },
      () => {
        onMessage('Current location was not available. Allow location access or paste a Google Maps link.');
        setBusy(undefined);
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };
  const clear = () => {
    onChange('');
    onMessage(`${label} link cleared. The mapped pin is unchanged until you set another location.`);
  };
  return (
    <div className={`map-link-field ${hasLink ? 'has-link' : 'is-empty'}`}>
      <span className="map-link-label">{label}</span>
      <div className="map-link-actions">
        <button className={hasLink ? 'secondary replace-link-button' : 'keep'} type="button" disabled={!!busy} onClick={paste}>
          {busy === 'paste' ? 'Pasting…' : hasLink ? 'Replace pasted link' : 'Paste copied link'}
        </button>
        <button className="secondary location-button" type="button" disabled={!!busy} onClick={useCurrentLocation}>
          {busy === 'location' ? 'Locating…' : 'Use current location'}
        </button>
      </div>
      <span className="map-link-status" role="status" aria-live="polite">
        <span aria-hidden="true">{hasLink ? '✓' : '○'}</span> {hasLink ? 'Link is in the field' : 'No link pasted yet'}
      </span>
      <details className="manual-map-link">
        <summary>Enter or edit link manually</summary>
        <label htmlFor={inputId}>Google Maps URL</label>
        <div className="map-link-input">
          <input
            id={inputId}
            type="url"
            inputMode="url"
            enterKeyHint="done"
            autoCapitalize="none"
            autoCorrect="off"
            placeholder="Paste a Google Maps link"
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
          <button className="clear-link" type="button" disabled={!value || !!busy} onClick={clear} aria-label={`Clear ${label} link`} title="Clear link">×</button>
        </div>
        <button className="secondary manual-use-link" type="button" disabled={!value.trim() || !!busy} onClick={apply}>
          {busy === 'link' ? 'Reading…' : 'Use manually entered link'}
        </button>
      </details>
    </div>
  );
}

type CommitNumberInputProps = {
  value: number | undefined;
  min: number;
  max: number;
  step: number;
  onCommit: (value: number) => void;
  ariaLabel?: string;
  integer?: boolean;
  disabled?: boolean;
};

function CommitNumberInput({ value, min, max, step, onCommit, ariaLabel, integer, disabled }: CommitNumberInputProps) {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(value === undefined ? '' : String(value));
  }, [editing, value]);
  const commit = () => {
    setEditing(false);
    const parsed = Number(draft.trim());
    if (!draft.trim() || !Number.isFinite(parsed)) {
      setDraft(value === undefined ? '' : String(value));
      return;
    }
    const next = Math.min(max, Math.max(min, integer ? Math.round(parsed) : parsed));
    setDraft(String(next));
    onCommit(next);
  };
  return <input
    type="text"
    inputMode={integer ? 'numeric' : 'decimal'}
    aria-label={ariaLabel}
    value={draft}
    disabled={disabled}
    onFocus={() => setEditing(true)}
    onChange={(event) => setDraft(event.target.value)}
    onBlur={commit}
    onKeyDown={(event) => {
      if (event.key === 'Enter') event.currentTarget.blur();
      if (event.key === 'Escape') {
        setDraft(value === undefined ? '' : String(value));
        event.currentTarget.blur();
      }
    }}
    data-min={min}
    data-max={max}
    data-step={step}
  />;
}

function browserPosition() {
  return new Promise<Position | undefined>((resolve) => {
    if (!navigator.geolocation) {
      resolve(undefined);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ lat: coords.latitude, lng: coords.longitude }),
      () => resolve(undefined),
      { enableHighAccuracy: true, maximumAge: 15_000, timeout: 8_000 },
    );
  });
}

function keepMobileFieldVisible(element: HTMLElement) {
  if (!window.matchMedia('(max-width: 819px)').matches) return;
  const reveal = () => {
    if (element.isConnected) element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  };
  requestAnimationFrame(reveal);
  window.setTimeout(reveal, 280);
  window.setTimeout(reveal, 650);
}

function answerOptions(kind: QuestionKind) {
  if (kind === 'thermometer') return ['warmer', 'colder'];
  if (kind === 'measuring') return ['closer', 'farther', 'null'];
  if (kind === 'coastline') return ['closer', 'farther'];
  if (kind === 'matching-region') return ['yes', 'no', 'null'];
  if (kind === 'tentacle') return ['yes', 'not-within-reach'];
  return ['yes', 'no'];
}

function defaultCategory(kind: QuestionKind): string | undefined {
  if (kind === 'measuring') return 'rail-station';
  if (kind === 'matching-region' || kind === 'tentacle') return 'museum';
  if (kind === 'photo-reference') return 'a-tree';
  return undefined;
}

const tentacleSubjects: RulebookSubject[] = TENTACLE_CATEGORIES.map((id) => ({
  id,
  label: CATEGORY_LABELS[id as PoiCategory],
  status: 'in-play',
  support: 'exact',
  notes: ['Medium-game card included by the SF house rule: 1-mile reach.'],
}));

function subjectChoices(kind: QuestionKind) {
  if (kind === 'measuring') return measuringChoices;
  if (kind === 'matching-region') return matchingChoices;
  if (kind === 'tentacle') return tentacleSubjects;
  if (kind === 'photo-reference') return photoChoices;
  return [];
}

function defaultAnswer(kind: QuestionKind): Constraint['answer'] {
  if (kind === 'thermometer') return 'colder';
  if (kind === 'measuring' || kind === 'coastline') return 'closer';
  if (kind === 'endgame-confirmation') return 'no';
  return 'yes';
}

function soloPreviewBranches(constraint: Constraint) {
  if (constraint.kind === 'radar' || constraint.kind === 'matching-region') return [
    { answer: 'yes' as const, label: 'Yes' },
    { answer: 'no' as const, label: 'Inverse · No' },
  ];
  if (constraint.kind === 'thermometer') return [
    { answer: 'warmer' as const, label: 'Hotter' },
    { answer: 'colder' as const, label: 'Inverse · Colder' },
  ];
  if (constraint.kind === 'measuring' || constraint.kind === 'coastline') return [
    { answer: 'closer' as const, label: 'Closer' },
    { answer: 'farther' as const, label: 'Inverse · Further' },
  ];
  if (constraint.kind === 'tentacle') return [
    { answer: 'yes' as const, label: 'Any named match' },
    { answer: 'not-within-reach' as const, label: 'Inverse · none in reach' },
  ];
  if (constraint.kind === 'endgame-confirmation') return [
    { answer: 'yes' as const, label: 'Yes zone' },
    { answer: 'no' as const, label: 'Inverse · outside' },
  ];
  return [];
}

type SoloAnswerSheet = {
  questionName: string;
  record: SoloQuestionRecord;
  fallbackMessage?: string;
};

export default function App() {
  const mapNode = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const placeInfoWindowRef = useRef<google.maps.InfoWindow | null>(null);
  const radarPreviewRef = useRef<{ constraintId: string; circle: google.maps.Circle } | null>(null);
  const drawn = useRef<google.maps.Data | null>(null);
  const currentLocationLayerRef = useRef<google.maps.Data | null>(null);
  const currentLocationFeatureRef = useRef<google.maps.Data.Feature | null>(null);
  const currentLocationCenteredRef = useRef(false);
  const questionNodesRef = useRef(new Map<string, HTMLElement>());
  const soloAnswerSheetRef = useRef<HTMLElement>(null);
  const [state, setState] = useState<SharedState>(() => initialSolo?.boardState ?? restoredState());
  const [solo, setSolo] = useState<SoloClientSession | undefined>(initialSolo);
  const [menuOpen, setMenuOpen] = useState(false);
  const [soloSetupOpen, setSoloSetupOpen] = useState(false);
  const [soloPanelOpen, setSoloPanelOpen] = useState(true);
  const [soloBusy, setSoloBusy] = useState(false);
  const [soloClock, setSoloClock] = useState(Date.now());
  const [soloStartMapUrl, setSoloStartMapUrl] = useState('');
  const [soloStartPosition, setSoloStartPosition] = useState<Position | undefined>();
  const [soloDateTime, setSoloDateTime] = useState(() => defaultSfDateTime());
  const [soloHidingTimeMinutes, setSoloHidingTimeMinutes] = useState(30);
  const [soloPreview, setSoloPreview] = useState<{ constraintId: string; answer: Constraint['answer']; label: string }>();
  const [gameSummaryOpen, setGameSummaryOpen] = useState(Boolean(initialSolo?.reveal && initialSolo.reveal.reason !== 'peek'));
  const [soloAnswerSheet, setSoloAnswerSheet] = useState<SoloAnswerSheet>();
  const [curseVetoEffectId, setCurseVetoEffectId] = useState<string>();
  const [curseVetoReason, setCurseVetoReason] = useState<'not-available' | 'unsafe' | 'closed' | 'other'>('not-available');
  const [curseVetoNote, setCurseVetoNote] = useState('');
  const [finishMapUrl, setFinishMapUrl] = useState('');
  const [hangmanGuess, setHangmanGuess] = useState('');
  const [currentLocationVisible, setCurrentLocationVisible] = useState(false);
  const [currentLocation, setCurrentLocation] = useState<Position | undefined>();
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const [stationSearch, setStationSearch] = useState('');
  const [selectedStation, setSelectedStation] = useState(validStations[0]?.id ?? '');
  const [focusedStation, setFocusedStation] = useState<string>();
  const [manualBoundaryEditing, setManualBoundaryEditing] = useState(false);
  const [manualBoundaryDraft, setManualBoundaryDraft] = useState<ManualReachRegion[]>([]);
  const [activeBoundaryRegionId, setActiveBoundaryRegionId] = useState<string>();
  const [traceActive, setTraceActive] = useState(false);
  const [traceScreenshot, setTraceScreenshot] = useState(false);
  const [tracePoints, setTracePoints] = useState<Position[]>([]);
  const [selectedConstraintId, setSelectedConstraintId] = useState<string>();
  const [droppedPin, setDroppedPin] = useState<Position>();
  const longPress = useMemo(() => createLongPressController<Position>((position) => {
    const map = mapRef.current;
    const infoWindow = placeInfoWindowRef.current;
    if (!map || !infoWindow) return;
    setDroppedPin(position);
    showMapLinkCard(infoWindow, map, position, googleMapsLinkForPosition(position), setMessage, 'Dropped pin', () => setDroppedPin(undefined));
  }), []);

  const partitions = useMemo(
    () => Object.fromEntries(REGION_CATEGORIES.map((category) => [category, partition(category)])),
    [],
  ) as Record<PoiCategory, ReturnType<typeof partition>>;
  const selectedPoiPartition = activePoiPartition(state.layers);
  const selectedPartitionLayer = activeMapPartition(state.layers);
  const selectedPartitionPois = useMemo(
    () => selectedPoiPartition ? pois.filter((poi) => poi.category === selectedPoiPartition) : [],
    [selectedPoiPartition],
  );
  const scopedRoutes = state.transitScope === 'primary' ? primaryTransitRoutes : transitRoutes;
  const scopedRouteIds = useMemo(() => new Set(scopedRoutes.map((route) => route.id)), [scopedRoutes]);
  const scopedStationIds = useMemo(
    () => new Set(state.transitScope === 'primary' ? primaryTransitStationIds : validStations.map((station) => station.id)),
    [state.transitScope],
  );
  const scopedStations = useMemo(
    () => validStations.filter((station) => scopedStationIds.has(station.id)),
    [scopedStationIds],
  );
  const filteredStations = useMemo(
    () => filterStationsBySearch(scopedStations, stationSearch),
    [scopedStations, stationSearch],
  );
  const activeBoundaryRegion = manualBoundaryDraft.find((region) => region.id === activeBoundaryRegionId);
  const allRouteEligibility = scopedRoutes.every((route) => state.routeStatuses[route.id] === 'in')
    ? 'in'
    : scopedRoutes.every((route) => state.routeStatuses[route.id] === 'out')
      ? 'out'
      : scopedRoutes.every((route) => state.routeStatuses[route.id] === undefined)
        ? ''
        : 'mixed';
  const regions = useMemo(() => Object.assign({}, ...Object.values(partitions)), [partitions]);
  const statusEligibleIds = useMemo(
    () => eligibleStationIds(
      state.stationStatuses,
      Object.fromEntries(Object.entries(state.routeStatuses).filter(([id]) => scopedRouteIds.has(id))),
    ).filter((id) => scopedStationIds.has(id)),
    [scopedRouteIds, scopedStationIds, state.routeStatuses, state.stationStatuses],
  );
  const currentEvidence = useMemo(() => (solo?.cardState?.evidence ?? []).filter((evidence) =>
    evidence.positionRevision === (solo?.cardState?.positionRevision ?? 0)),
  [solo?.cardState?.evidence, solo?.cardState?.positionRevision]);
  const evidenceConstraints = useMemo(() => currentEvidence.map((evidence) => ({
    id: `evidence-${evidence.id}`,
    name: evidence.label,
    kind: 'thermometer' as const,
    enabled: true,
    answer: 'colder' as const,
    answerSet: true,
    origin: evidence.nearer,
    originSet: true,
    target: evidence.farther,
    targetSet: true,
  } satisfies Constraint)), [currentEvidence]);
  const cursePlaces = useMemo(() => (solo?.cardState?.activeCurses ?? []).filter((effect) =>
    effect.placePosition && !currentEvidence.some((evidence) => evidence.id === effect.id)),
  [currentEvidence, solo?.cardState?.activeCurses]);
  const committedManualReachArea = useMemo(() => state.manualReachBoundary?.regions.length
    ? manualReachArea(state.manualReachBoundary.regions)
    : undefined,
  [state.manualReachBoundary?.regions]);
  const draftManualReachArea = useMemo(() => manualBoundaryEditing
    ? manualReachArea(manualBoundaryDraft)
    : undefined,
  [manualBoundaryDraft, manualBoundaryEditing]);
  const committedConstraints = useMemo(() => solo
    ? state.constraints.filter((constraint) => Boolean(solo.questions[constraint.id]) && constraint.enabled)
    : state.constraints,
  [solo, state.constraints]);
  const previewConstraint = soloPreview
    ? state.constraints.find((constraint) => constraint.id === soloPreview.constraintId)
    : undefined;
  const stationQuestionConstraints = useMemo(() => previewConstraint && soloPreview
    ? [...committedConstraints, { ...previewConstraint, enabled: true, answer: soloPreview.answer }]
    : committedConstraints,
  [committedConstraints, previewConstraint, soloPreview]);
  const questionEligibleIds = useMemo(
    () => stationIdsMatchingTransitQuestions(statusEligibleIds, stationQuestionConstraints).filter((id) => {
      const station = validStations.find((candidate) => candidate.id === id);
      return !!station && isHidingPositionAllowed(station);
    }),
    [stationQuestionConstraints, statusEligibleIds],
  );
  const baseFeasible = useMemo(
    () => {
      const questionArea = combineConstraints([...committedConstraints, ...evidenceConstraints], regions);
      const manuallyBounded = state.manualReachBoundary?.enabled && committedManualReachArea
        ? turf.intersect(turf.featureCollection([questionArea, committedManualReachArea])) as Area | null
        : questionArea;
      return (manuallyBounded && turf.intersect(turf.featureCollection([manuallyBounded, allowedHidingArea])) as Area | null) ?? ({
        type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] },
      } satisfies Area);
    },
    [committedConstraints, committedManualReachArea, evidenceConstraints, regions, state.manualReachBoundary?.enabled],
  );
  const feasible = useMemo(() => {
    if (!previewConstraint || !soloPreview) return baseFeasible;
    const preview = questionPreviewArea(previewConstraint, soloPreview.answer, regions, state.stationZoneMiles);
    return (turf.intersect(turf.featureCollection([baseFeasible, preview])) as Area | null) ?? ({
      type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] },
    } satisfies Area);
  }, [baseFeasible, previewConstraint, regions, soloPreview, state.stationZoneMiles]);
  const excluded = useMemo(() => excludedArea(feasible), [feasible]);
  const eligibleIds = useMemo(
    () => stationIdsOverlappingArea(questionEligibleIds, state.stationZoneMiles, feasible),
    [feasible, questionEligibleIds, state.stationZoneMiles],
  );
  const traceDistanceMiles = useMemo(
    () => pathDistanceMiles(tracePoints),
    [tracePoints],
  );
  const selectedRadar = state.constraints.find(
    (constraint) => constraint.id === selectedConstraintId && constraint.kind === 'radar' && questionIsReady(constraint),
  );
  const readyConstraints = state.constraints.filter(questionIsReady);
  const countedQuestionIds = useMemo(
    () => new Set(solo
      ? Object.keys(solo.questions)
      : state.constraints.filter(questionIsReady).map((constraint) => constraint.id)),
    [solo?.questions, state.constraints],
  );
  const inferredUseCounts = useMemo(
    () => questionUseCounts(state.constraints.filter((constraint) => countedQuestionIds.has(constraint.id))),
    [countedQuestionIds, state.constraints],
  );
  // New sessions receive the sealed session's authoritative counts. Keep the
  // inferred fallback so games saved before questionUses became public still load.
  const useCounts = solo?.questionUses ? normalizeQuestionUses(solo.questionUses) : inferredUseCounts;
  const soloEffectClock = solo?.pausedAt ? Date.parse(solo.pausedAt) : soloClock;
  const soloVisibleCurses = (solo?.cardState?.activeCurses ?? []).filter((effect) =>
    !effect.expiresAt || Date.parse(effect.expiresAt) > soloEffectClock);
  const soloQuestionBlocked = soloVisibleCurses.some((effect) => effect.blocksQuestions);
  const soloTimerKey = [
    ...(solo?.cardState?.activeCurses ?? []).flatMap((effect) => [effect.lockedUntil, effect.expiresAt]),
  ].filter(Boolean).join('|');

  const priorUsesFor = (
    current: Constraint,
    candidate: Pick<Constraint, 'kind' | 'distanceMiles' | 'category'> = current,
  ) => {
    const candidateKey = canonicalQuestionKey(candidate);
    const includesCurrent = countedQuestionIds.has(current.id) && canonicalQuestionKey(current) === candidateKey;
    return Math.max(0, (useCounts[candidateKey] ?? 0) - (includesCurrent ? 1 : 0));
  };

  const askedUsesFor = (candidate: Pick<Constraint, 'kind' | 'distanceMiles' | 'category'>) =>
    solo ? useCounts[canonicalQuestionKey(candidate)] ?? 0 : 0;

  const addManualBoundaryPoint = (position: Position) => {
    if (!manualBoundaryEditing || !activeBoundaryRegionId || !insideSanFrancisco(position)) return;
    setManualBoundaryDraft((current) => current.map((region) => region.id === activeBoundaryRegionId
      ? { ...region, points: [...region.points, position].slice(0, 200) }
      : region));
  };

  useEffect(() => {
    if (!solo) {
      localStorage.removeItem(SOLO_STORAGE_KEY);
      return;
    }
    localStorage.setItem(SOLO_STORAGE_KEY, JSON.stringify({ ...solo, boardState: state }));
  }, [solo, state]);

  useEffect(() => {
    if (!solo) persistManualReachBoundary(localStorage, currentConfigKey(), state.manualReachBoundary);
  }, [solo, state.manualReachBoundary]);

  useEffect(() => {
    if (solo?.pausedAt) return;
    const now = Date.now();
    const nextTimer = soloTimerKey.split('|').map(Date.parse).filter((time) => time > now).sort((a, b) => a - b)[0];
    if (!nextTimer) return;
    const timeoutId = window.setTimeout(() => setSoloClock(Date.now()), Math.max(0, nextTimer - now + 25));
    return () => window.clearTimeout(timeoutId);
  }, [solo?.pausedAt, soloTimerKey, soloClock]);

  useEffect(() => {
    if (!solo || solo.phase === 'found' || solo.phase === 'gave-up' || solo.pausedAt) return;
    const intervalId = window.setInterval(() => setSoloClock(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [solo?.pausedAt, solo?.phase]);

  useEffect(() => {
    if (!message || status !== 'ready') return;
    const timeoutId = window.setTimeout(() => {
      setMessage((current) => current === message ? '' : current);
    }, 6000);
    return () => window.clearTimeout(timeoutId);
  }, [message, status]);

  useEffect(() => {
    if (!soloAnswerSheet) return;
    requestAnimationFrame(() => soloAnswerSheetRef.current?.focus({ preventScroll: true }));
  }, [soloAnswerSheet]);

  useEffect(() => () => longPress.dispose(), [longPress]);

  useEffect(() => {
    if (!filteredStations.some((station) => station.id === selectedStation)) {
      setSelectedStation(filteredStations[0]?.id ?? '');
    }
  }, [filteredStations, selectedStation]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const revealFocusedSearch = () => {
      const focused = document.activeElement;
      if (focused instanceof HTMLInputElement && focused.type === 'search') keepMobileFieldVisible(focused);
    };
    viewport.addEventListener('resize', revealFocusedSearch);
    viewport.addEventListener('scroll', revealFocusedSearch);
    return () => {
      viewport.removeEventListener('resize', revealFocusedSearch);
      viewport.removeEventListener('scroll', revealFocusedSearch);
    };
  }, []);

  useEffect(() => {
    if (!currentLocationVisible) {
      currentLocationCenteredRef.current = false;
      return;
    }
    if (!navigator.geolocation) {
      setMessage('Current location is unavailable in this browser.');
      setCurrentLocationVisible(false);
      return;
    }
    const watchId = navigator.geolocation.watchPosition(
      ({ coords }) => {
        const position = { lat: coords.latitude, lng: coords.longitude };
        if (!insideSanFrancisco(position)) {
          setMessage('Your current location is outside the San Francisco map bounds.');
          setCurrentLocationVisible(false);
          return;
        }
        setCurrentLocation(position);
      },
      () => {
        setMessage('Current location was not available. Check the browser location permission and try again.');
        setCurrentLocationVisible(false);
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [currentLocationVisible]);

  useEffect(() => {
    const key = import.meta.env.VITE_GOOGLE_MAPS_BROWSER_API_KEY;
    if (!key) {
      setStatus('error');
      setMessage('Add VITE_GOOGLE_MAPS_BROWSER_API_KEY to .env to load the map.');
      return;
    }
    let cancelled = false;
    let map: google.maps.Map | null = null;
    loadGoogleMaps(key)
      .then(() => {
        if (cancelled || !mapNode.current) return;
        map = new google.maps.Map(mapNode.current, {
          center: state.viewport.center,
          zoom: state.viewport.zoom,
          restriction: { latLngBounds: SF_BOUNDS, strictBounds: false },
          mapTypeControl: false,
          fullscreenControl: false,
          streetViewControl: false,
          gestureHandling: 'greedy',
        });
        mapRef.current = map;
        placeInfoWindowRef.current = new google.maps.InfoWindow();
        setStatus('ready');
        map.addListener('idle', () => {
          const center = map?.getCenter();
          if (center) {
            setState((current) => ({
              ...current,
              viewport: { center: { lat: center.lat(), lng: center.lng() }, zoom: map?.getZoom() ?? 12 },
            }));
          }
        });
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('error');
        setMessage('Google Maps could not load. Check the API key, referrer restrictions, and network connection.');
      });
    return () => {
      cancelled = true;
      if (map) google.maps.event.clearInstanceListeners(map);
      placeInfoWindowRef.current?.close();
      placeInfoWindowRef.current = null;
      if (mapRef.current === map) mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const infoWindow = placeInfoWindowRef.current;
    if (!map || !infoWindow || status !== 'ready') return;
    const listener = map.addListener('click', (event: google.maps.MapMouseEvent | google.maps.IconMouseEvent) => {
      if (longPress.shouldSuppressClick()) return;
      const latLng = event.latLng;
      if (!latLng) return;
      const position = { lat: latLng.lat(), lng: latLng.lng() };
      const placeId = 'placeId' in event ? event.placeId : undefined;
      if (manualBoundaryEditing) {
        if (placeId) event.stop();
        infoWindow.close();
        addManualBoundaryPoint(position);
        return;
      }
      if (traceActive) {
        infoWindow.close();
        if (insideSanFrancisco(position)) setTracePoints((current) => [...current, position]);
        return;
      }
      if (!placeId) {
        infoWindow.close();
        return;
      }
      event.stop();
      showMapLinkCard(infoWindow, map, position, googleMapsLinkForPlace(placeId, position), setMessage);
    });
    return () => listener.remove();
  }, [activeBoundaryRegionId, longPress, manualBoundaryEditing, status, traceActive]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== 'ready') return;
    const start = map.addListener('mousedown', (event: google.maps.MapMouseEvent) => {
      if (event.latLng) longPress.start({ lat: event.latLng.lat(), lng: event.latLng.lng() });
    });
    const mouseup = map.addListener('mouseup', longPress.cancel);
    const dragstart = map.addListener('dragstart', longPress.cancel);
    return () => {
      start.remove();
      mouseup.remove();
      dragstart.remove();
      longPress.cancel();
    };
  }, [longPress, status]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== 'ready') return;
    map.setOptions(traceScreenshot ? {
      backgroundColor: '#f8fafc',
      disableDefaultUI: true,
      gestureHandling: 'none',
      keyboardShortcuts: false,
      styles: [{ featureType: 'all', elementType: 'all', stylers: [{ visibility: 'off' }] }],
    } : {
      backgroundColor: '#dce5ed',
      disableDefaultUI: false,
      fullscreenControl: false,
      gestureHandling: 'greedy',
      keyboardShortcuts: true,
      mapTypeControl: false,
      streetViewControl: false,
      styles: [],
    });
  }, [status, traceScreenshot]);

  useEffect(() => {
    radarPreviewRef.current?.circle.setMap(null);
    radarPreviewRef.current = null;
    const distanceMiles = selectedRadar?.distanceMiles;
    const map = mapRef.current;
    if (!map || status !== 'ready' || traceScreenshot || !selectedRadar || !Number.isFinite(distanceMiles) || !distanceMiles || distanceMiles <= 0) return;

    const circle = new google.maps.Circle({
      map,
      center: selectedRadar.origin,
      radius: distanceMiles * 1609.344,
      clickable: false,
      fillColor: '#f59e0b',
      fillOpacity: 0.07,
      strokeColor: '#b45309',
      strokeOpacity: 1,
      strokeWeight: 4,
      zIndex: 25,
    });
    radarPreviewRef.current = { constraintId: selectedRadar.id, circle };

    return () => {
      circle.setMap(null);
      if (radarPreviewRef.current?.circle === circle) radarPreviewRef.current = null;
    };
  }, [selectedRadar?.distanceMiles, selectedRadar?.id, selectedRadar?.origin.lat, selectedRadar?.origin.lng, status, traceScreenshot]);

  useEffect(() => {
    if (state.mode !== 'hider' && traceScreenshot) setTraceScreenshot(false);
  }, [state.mode, traceScreenshot]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== 'ready' || !solo?.reveal) return;
    const bounds = new google.maps.LatLngBounds();
    bounds.extend(solo.reveal.station.position);
    bounds.extend(solo.reveal.spot);
    map.fitBounds(bounds, 80);
  }, [solo?.reveal, status]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== 'ready') return;
    if (!currentLocationVisible || !currentLocation) {
      currentLocationLayerRef.current?.setMap(null);
      currentLocationLayerRef.current = null;
      currentLocationFeatureRef.current = null;
      return;
    }

    let data = currentLocationLayerRef.current;
    if (!data) {
      data = new google.maps.Data({ map });
      data.setStyle({
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          fillColor: '#0ea5e9',
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 3,
          scale: 7,
        },
        zIndex: 40,
      });
      currentLocationLayerRef.current = data;
    }

    const geometry = new google.maps.Data.Point(currentLocation);
    if (currentLocationFeatureRef.current) {
      currentLocationFeatureRef.current.setGeometry(geometry);
    } else {
      currentLocationFeatureRef.current = data.add({ geometry });
    }

    if (!currentLocationCenteredRef.current) {
      map.panTo(currentLocation);
      currentLocationCenteredRef.current = true;
    }
  }, [currentLocation, currentLocationVisible, status]);

  useEffect(() => () => {
    currentLocationLayerRef.current?.setMap(null);
    currentLocationLayerRef.current = null;
    currentLocationFeatureRef.current = null;
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== 'ready') return;
    drawn.current?.setMap(null);
    const data = new google.maps.Data({ map });
    drawn.current = data;

    if (selectedPoiPartition) {
      selectedPartitionPois.forEach((poi, index) => {
        const feature = partitions[selectedPoiPartition][poi.id];
        const color = partitionColor(index, selectedPartitionPois.length);
        if (feature) data.addGeoJson({
          ...feature,
          properties: { kind: 'region', color, id: poi.id, areaName: poi.name, number: index + 1 },
        });
        if (state.layers['partition-pins'] !== false) {
          data.addGeoJson({
            type: 'Feature',
            properties: { kind: 'poi-source', color, id: poi.id, areaName: poi.name, number: index + 1 },
            geometry: { type: 'Point', coordinates: [poi.lng, poi.lat] },
          });
        }
      });
    }
    const geographicPartitions = [
      { key: 'supervisor-districts', collection: supervisorDistricts, offset: 15, kind: 'geographic-region', showPins: true },
      { key: 'zip-codes', collection: zipCodeAreas, offset: 210, kind: 'geographic-region', showPins: true },
      { key: 'landmasses', collection: sfLandmasses, offset: 35, kind: 'geographic-region', showPins: true },
      { key: 'no-hide-zones', collection: bufferedNoHideZones, offset: 0, kind: 'no-hide-region', showPins: false },
    ];
    geographicPartitions.filter(({ key }) => state.layers[key]).forEach(({ collection, offset, kind, showPins }) => {
      collection.features.forEach((feature, index) => {
        const color = kind === 'no-hide-region' ? '#111827' : partitionColor(index, collection.features.length, offset);
        data.addGeoJson({
          ...feature,
          properties: { ...feature.properties, kind, color, areaName: feature.properties.name },
        });
        if (showPins && state.layers['partition-pins'] !== false) {
          const labelPosition = partitionLabelPosition(feature);
          data.addGeoJson({
            type: 'Feature',
            properties: { kind: 'partition-source', color, areaName: feature.properties.name, label: feature.properties.name },
            geometry: { type: 'Point', coordinates: [labelPosition.lng, labelPosition.lat] },
          });
        }
      });
    });
    if (focusedStation || state.layers['transit-routes'] || (state.transitScope === 'all' && state.layers['other-transit-routes'])) {
      transitRouteGeoJson.features.filter((feature) =>
        focusedStation && routesForStation(focusedStation).includes(feature.properties.routeId)
          ? scopedRouteIds.has(feature.properties.routeId)
          : feature.properties.mode === 'other-transit'
          ? state.transitScope === 'all' && state.layers['other-transit-routes']
          : state.layers['transit-routes'],
      ).forEach((feature) => {
        const routeStatus = state.routeStatuses[feature.properties.routeId];
        const focused = Boolean(focusedStation && routesForStation(focusedStation).includes(feature.properties.routeId));
        data.addGeoJson({ ...feature, properties: { ...feature.properties, kind: 'transit-route', status: routeStatus ?? '', focused, areaName: transitRouteLabel(feature.properties) } });
      });
    }
    scopedStations.forEach((station) => {
      const eligible = eligibleIds.includes(station.id);
      const stationStatus = state.stationStatuses[station.id];
      data.addGeoJson({
        type: 'Feature',
        properties: { kind: 'station', id: station.id, status: stationStatus ?? '', eligible, focused: focusedStation === station.id, areaName: station.name },
        geometry: { type: 'Point', coordinates: [station.lng, station.lat] },
      });
      if (shouldDisplayStationZone(state.layers['station-zones'], eligible)) {
        data.addGeoJson({
          ...turf.circle([station.lng, station.lat], state.stationZoneMiles, { units: 'miles', steps: 24 }),
          properties: { kind: 'station-zone', id: station.id, status: stationStatus ?? '', eligible, focused: focusedStation === station.id, areaName: station.name },
        });
      }
    });
    if (!manualBoundaryEditing && state.manualReachBoundary?.visible && committedManualReachArea?.geometry.coordinates.length) {
      data.addGeoJson({
        ...committedManualReachArea,
        properties: { kind: 'manual-reach-boundary', areaName: 'User-researched maximum reach boundary', enabled: state.manualReachBoundary.enabled },
      });
    }
    if (manualBoundaryEditing) {
      if (draftManualReachArea?.geometry.coordinates.length) {
        data.addGeoJson({ ...draftManualReachArea, properties: { kind: 'manual-reach-draft', areaName: 'Unsaved maximum reach preview' } });
      }
      manualBoundaryDraft.forEach((region, regionIndex) => region.points.forEach((position, pointIndex) => data.addGeoJson({
        type: 'Feature',
        properties: { kind: 'manual-reach-point', areaName: `Region ${regionIndex + 1}, point ${pointIndex + 1}`, active: region.id === activeBoundaryRegionId },
        geometry: { type: 'Point', coordinates: [position.lng, position.lat] },
      })));
    }
    if (solo?.startPosition) {
      data.addGeoJson({
        type: 'Feature',
        properties: { kind: 'solo-start', areaName: 'Original Solo starting location' },
        geometry: { type: 'Point', coordinates: [solo.startPosition.lng, solo.startPosition.lat] },
      });
    }
    currentEvidence.forEach((evidence) => data.addGeoJson({
      type: 'Feature',
      properties: { kind: 'solo-evidence', areaName: evidence.placeName ?? evidence.label },
      geometry: { type: 'Point', coordinates: [evidence.farther.lng, evidence.farther.lat] },
    }));
    cursePlaces.forEach((effect) => effect.placePosition && data.addGeoJson({
      type: 'Feature',
      properties: { kind: 'solo-curse-place', areaName: `${effect.name}: ${effect.placeName ?? 'mapped destination'}` },
      geometry: { type: 'Point', coordinates: [effect.placePosition.lng, effect.placePosition.lat] },
    }));
    if (droppedPin) {
      data.addGeoJson({
        type: 'Feature',
        properties: { kind: 'dropped-pin', areaName: 'Dropped pin' },
        geometry: { type: 'Point', coordinates: [droppedPin.lng, droppedPin.lat] },
      });
    }
    solo?.cardState?.moves.forEach((move) => data.addGeoJson({
      type: 'Feature',
      properties: { kind: 'solo-move-station', areaName: `Station revealed by Move: ${move.oldStation.name}` },
      geometry: { type: 'Point', coordinates: [move.oldStation.position.lng, move.oldStation.position.lat] },
    }));
    if (solo?.reveal) soloRevealMapFeatures(solo.reveal).forEach((feature) => data.addGeoJson(feature));
    const displayedArea = state.areaDisplayMode === 'excluded-red'
      ? { area: excluded, kind: 'excluded' }
      : { area: feasible, kind: soloPreview ? 'preview-feasible' : 'feasible' };
    if (soloPreview && state.areaDisplayMode !== 'excluded-red' && baseFeasible.geometry.coordinates.length > 0) {
      data.addGeoJson({ ...baseFeasible, properties: { kind: 'feasible' } });
    }
    if (displayedArea.area.geometry.coordinates.length > 0) {
      data.addGeoJson({ ...displayedArea.area, properties: { kind: displayedArea.kind } });
    }
    if (state.mode === 'hider' && state.hiderPosition) {
      data.addGeoJson({
        type: 'Feature',
        properties: { kind: 'hider' },
        geometry: { type: 'Point', coordinates: [state.hiderPosition.lng, state.hiderPosition.lat] },
      });
    }
    const traceLine = pathGeoJson(tracePoints);
    if (traceLine) data.addGeoJson(traceLine);
    tracePoints.forEach((position, index) => data.addGeoJson({
      type: 'Feature',
      properties: { kind: 'trace-point', endpoint: index === 0 ? 'start' : index === tracePoints.length - 1 ? 'end' : '' },
      geometry: { type: 'Point', coordinates: [position.lng, position.lat] },
    }));

    data.setStyle((feature) => {
      const kind = feature.getProperty('kind');
      if (traceScreenshot && kind !== 'hider-trace' && kind !== 'trace-point') return { visible: false };
      const statusValue = feature.getProperty('status');
      const eligibilityValue = feature.getProperty('eligible');
      const routeStatus = statusValue === 'in' || statusValue === 'out' ? statusValue : undefined;
      const eligible = eligibilityValue !== false;
      if (kind === 'feasible') return { fillColor: '#16a34a', fillOpacity: 0.28, strokeColor: '#166534', strokeWeight: 3, zIndex: 1 };
      if (kind === 'preview-feasible') return { fillColor: '#f59e0b', fillOpacity: 0.3, strokeColor: '#b45309', strokeOpacity: 1, strokeWeight: 4, zIndex: 8 };
      if (kind === 'excluded') return { fillColor: '#dc2626', fillOpacity: 0.28, strokeColor: '#991b1b', strokeWeight: 2, zIndex: 1 };
      if (kind === 'manual-reach-boundary') return { fillColor: '#0f766e', fillOpacity: feature.getProperty('enabled') === true ? 0.06 : 0, strokeColor: '#0f766e', strokeOpacity: 1, strokeWeight: 4, zIndex: 9 };
      if (kind === 'manual-reach-draft') return { fillColor: '#f59e0b', fillOpacity: 0.11, strokeColor: '#b45309', strokeOpacity: 1, strokeWeight: 4, zIndex: 12 };
      if (kind === 'manual-reach-point') return { icon: { path: google.maps.SymbolPath.CIRCLE, fillColor: feature.getProperty('active') === true ? '#f59e0b' : '#64748b', fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 2, scale: 6 }, zIndex: 45 };
      if (kind === 'no-hide-region') return { fillColor: '#111827', fillOpacity: 0.42, strokeColor: '#020617', strokeOpacity: 0.9, strokeWeight: 3, zIndex: 7 };
      if (kind === 'hider-trace') return { strokeColor: '#e11d48', strokeOpacity: 0.95, strokeWeight: 5, zIndex: 20 };
      if (kind === 'trace-point') {
        const endpoint = feature.getProperty('endpoint');
        return { icon: { path: google.maps.SymbolPath.CIRCLE, fillColor: endpoint ? '#e11d48' : '#ffffff', fillOpacity: 1, strokeColor: '#e11d48', strokeWeight: 2, scale: endpoint ? 5 : 3 }, zIndex: 21 };
      }
      if (kind === 'solo-reveal') {
        const star = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><path d="M24 2l5.3 14.7 15.7.5-12.4 9.6L37 42l-13-9-13 9 4.4-15.2L3 17.2l15.7-.5L24 2Z" fill="#facc15" stroke="white" stroke-width="6" stroke-linejoin="round"/><path d="M24 2l5.3 14.7 15.7.5-12.4 9.6L37 42l-13-9-13 9 4.4-15.2L3 17.2l15.7-.5L24 2Z" fill="#facc15" stroke="#92400e" stroke-width="2" stroke-linejoin="round"/></svg>';
        return {
          icon: {
            url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(star)}`,
            scaledSize: new google.maps.Size(44, 44),
            anchor: new google.maps.Point(22, 22),
          },
          zIndex: 60,
        };
      }
      if (kind === 'solo-reveal-station') {
        const stationPin = '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="52" viewBox="0 0 44 52"><path d="M22 1C10.4 1 1 10.4 1 22c0 14.4 21 29 21 29s21-14.6 21-29C43 10.4 33.6 1 22 1Z" fill="#2563eb" stroke="white" stroke-width="2"/><circle cx="22" cy="21" r="12" fill="white"/><text x="22" y="26" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="800" fill="#1d4ed8">S</text></svg>';
        return {
          icon: {
            url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(stationPin)}`,
            scaledSize: new google.maps.Size(38, 45),
            anchor: new google.maps.Point(19, 44),
          },
          zIndex: 59,
        };
      }
      if (kind === 'solo-move-station') {
        return {
          icon: { path: google.maps.SymbolPath.CIRCLE, fillColor: '#f97316', fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 3, scale: 8 },
          zIndex: 55,
        };
      }
      if (kind === 'solo-start') {
        return {
          icon: { path: google.maps.SymbolPath.BACKWARD_CLOSED_ARROW, fillColor: '#0f766e', fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 2, scale: 7 },
          zIndex: 58,
        };
      }
      if (kind === 'solo-evidence') {
        return {
          icon: { path: google.maps.SymbolPath.CIRCLE, fillColor: '#7c3aed', fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 3, scale: 8 },
          zIndex: 57,
        };
      }
      if (kind === 'solo-curse-place') {
        return {
          icon: { path: google.maps.SymbolPath.CIRCLE, fillColor: '#c026d3', fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 3, scale: 8 },
          zIndex: 56,
        };
      }
      if (kind === 'dropped-pin') {
        const pin = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="48" viewBox="0 0 40 48"><path d="M20 1C9.5 1 1 9.5 1 20c0 13 19 27 19 27s19-14 19-27C39 9.5 30.5 1 20 1Z" fill="#dc2626" stroke="white" stroke-width="2"/><circle cx="20" cy="19" r="7" fill="white"/></svg>';
        return {
          icon: {
            url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(pin)}`,
            scaledSize: new google.maps.Size(34, 41),
            anchor: new google.maps.Point(17, 40),
          },
          zIndex: 61,
        };
      }
      if (kind === 'transit-route') {
        const mode = feature.getProperty('mode');
        const focused = feature.getProperty('focused') === true;
        return {
          strokeColor: focused ? '#f59e0b' : routeStatus === 'out' ? '#b91c1c' : routeStatus === 'in' ? '#15803d' : mode === 'light-rail' ? '#7c3aed' : mode === 'rapid-muni' ? '#ea580c' : '#64748b',
          strokeOpacity: routeStatus === 'out' ? 0.48 : mode === 'other-transit' ? 0.58 : 0.82,
          strokeWeight: focused ? 8 : routeStatus ? 6 : mode === 'other-transit' ? 2.5 : 4,
          zIndex: focused ? 18 : 3,
        };
      }
      if (kind === 'station-zone') {
        const color = !eligible || routeStatus === 'out' ? '#b91c1c' : routeStatus === 'in' ? '#15803d' : '#2563eb';
        return { fillColor: color, fillOpacity: eligible ? 0.11 : 0.045, strokeColor: color, strokeOpacity: 0.58, strokeWeight: 1 };
      }
      if (kind === 'station' || kind === 'hider') {
        const isHider = kind === 'hider';
        const focused = feature.getProperty('focused') === true;
        const color = isHider ? '#111827' : !eligible || routeStatus === 'out' ? '#b91c1c' : routeStatus === 'in' ? '#15803d' : '#2563eb';
        return {
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            fillColor: color,
            fillOpacity: 1,
            strokeColor: '#ffffff',
            strokeWeight: 1.5,
            scale: isHider ? 7 : focused ? 8 : 5,
          },
          zIndex: focused ? 40 : 10,
        };
      }
      if (kind === 'poi-source') {
        const colorValue = feature.getProperty('color');
        const color = typeof colorValue === 'string' ? colorValue : '#553c9a';
        const number = Number(feature.getProperty('number')) || 0;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="42" viewBox="0 0 34 42"><path d="M17 1C8.2 1 1 8.2 1 17c0 11.2 16 24 16 24s16-12.8 16-24C33 8.2 25.8 1 17 1Z" fill="${color}" stroke="white" stroke-width="2"/><circle cx="17" cy="17" r="10.5" fill="white" fill-opacity=".94"/><text x="17" y="21" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" font-weight="700" fill="#111827">${number}</text></svg>`;
        return {
          icon: {
            url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
            scaledSize: new google.maps.Size(30, 37),
            anchor: new google.maps.Point(15, 36),
          },
          zIndex: 30,
        };
      }
      if (kind === 'partition-source') {
        const colorValue = feature.getProperty('color');
        const color = typeof colorValue === 'string' ? colorValue : '#553c9a';
        const rawLabel = String(feature.getProperty('label') ?? '');
        const label = rawLabel.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character] ?? character);
        const width = Math.min(112, Math.max(38, 18 + rawLabel.length * 7));
        const center = width / 2;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="38" viewBox="0 0 ${width} 38"><path d="M8 1h${width - 16}a7 7 0 0 1 7 7v15a7 7 0 0 1-7 7h-${Math.max(1, width / 2 - 10)}L${center} 37l-8-7H8a7 7 0 0 1-7-7V8a7 7 0 0 1 7-7Z" fill="${color}" stroke="white" stroke-width="2"/><text x="${center}" y="20" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" font-weight="700" fill="white">${label}</text></svg>`;
        return {
          icon: {
            url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
            scaledSize: new google.maps.Size(width, 38),
            anchor: new google.maps.Point(center, 37),
          },
          zIndex: 29,
        };
      }
      const colorValue = feature.getProperty('color');
      const regionColor = typeof colorValue === 'string' ? colorValue : '#553c9a';
      return { fillColor: regionColor, fillOpacity: kind === 'geographic-region' ? 0.07 : 0.14, strokeColor: regionColor, strokeWeight: kind === 'geographic-region' ? 2 : 1.5, zIndex: kind === 'region' ? 4 : 2 };
    });
    data.addListener('click', (event: google.maps.Data.MouseEvent) => {
      if (longPress.shouldSuppressClick()) return;
      if (manualBoundaryEditing && event.latLng) {
        const position = { lat: event.latLng.lat(), lng: event.latLng.lng() };
        addManualBoundaryPoint(position);
        return;
      }
      if (event.feature.getProperty('kind') === 'dropped-pin' && event.latLng) {
        const position = { lat: event.latLng.lat(), lng: event.latLng.lng() };
        showMapLinkCard(placeInfoWindowRef.current!, map, position, googleMapsLinkForPosition(position), setMessage, 'Dropped pin', () => setDroppedPin(undefined));
        return;
      }
      if (traceActive && event.latLng) {
        const next = { lat: event.latLng.lat(), lng: event.latLng.lng() };
        if (insideSanFrancisco(next)) setTracePoints((current) => [...current, next]);
        return;
      }
      const kind = event.feature.getProperty('kind');
      if (kind === 'station' || kind === 'station-zone') {
        const id = event.feature.getProperty('id');
        if (typeof id === 'string' && scopedStationIds.has(id)) {
          setSelectedStation(id);
          setFocusedStation(id);
          setStationSearch('');
        }
        return;
      }
      const areaName = event.feature.getProperty('areaName');
      if (typeof areaName === 'string') setMessage(areaName);
    });
    data.addListener('mousedown', (event: google.maps.Data.MouseEvent) => {
      if (event.latLng) longPress.start({ lat: event.latLng.lat(), lng: event.latLng.lng() });
    });
    data.addListener('mouseup', longPress.cancel);
    data.addListener('mouseout', longPress.cancel);
  }, [activeBoundaryRegionId, baseFeasible, committedManualReachArea, currentEvidence, cursePlaces, draftManualReachArea, droppedPin, eligibleIds, excluded, feasible, focusedStation, longPress, manualBoundaryDraft, manualBoundaryEditing, partitions, scopedRouteIds, scopedStationIds, scopedStations, selectedPartitionPois, selectedPoiPartition, solo?.cardState?.moves, solo?.reveal, solo?.startPosition, soloPreview, state.areaDisplayMode, state.hiderPosition, state.layers, state.manualReachBoundary, state.mode, state.routeStatuses, state.stationStatuses, state.stationZoneMiles, state.transitScope, status, traceActive, tracePoints, traceScreenshot]);

  const patchConstraint = (id: string, update: Partial<Constraint>) =>
    setState((current) => {
      let startsEndGame = false;
      const constraints = current.constraints.map((constraint) => {
        if (constraint.id !== id) return constraint;
        const wasReady = questionIsReady(constraint);
        const next = { ...constraint, ...update, ...(constraint.kind === 'tentacle' ? { distanceMiles: 1 } : {}) };
        const ready = questionIsReady(next);
        if (next.kind === 'endgame-confirmation' && next.answer === 'yes' && ready) startsEndGame = true;
        const isCommittedSoloAnswer = Boolean(solo?.questions[id]);
        return { ...next, enabled: ready ? (!wasReady && (!solo || isCommittedSoloAnswer) ? true : next.enabled) : false };
      });
      return { ...current, constraints, endGameActive: current.endGameActive || startsEndGame };
    });

  const add = async () => {
    const kind = (document.querySelector('#kind') as HTMLSelectElement).value as QuestionKind;
    const category = solo && kind === 'photo-reference' ? SOLO_PHOTO_SUBJECTS[0].id : defaultCategory(kind);
    const needsOrigin = questionRequiresOrigin({ kind, category });
    let origin = currentLocation;
    if (needsOrigin && !origin) {
      const located = await browserPosition();
      if (located && insideSanFrancisco(located)) {
        origin = located;
        setCurrentLocation(located);
      }
    }
    const resolvedOrigin = origin ?? state.viewport.center;
    const regionId = category ? nearestPoi(category, resolvedOrigin)?.id : undefined;
    const id = crypto.randomUUID();
    const draft: Constraint = {
      id,
      name: QUESTION_DEFINITIONS[kind].label,
      kind,
      enabled: false,
      answer: defaultAnswer(kind),
      answerSet: !!solo || kind !== 'endgame-confirmation',
      origin: resolvedOrigin,
      originSet: !needsOrigin || Boolean(origin),
      originMapUrl: needsOrigin && origin ? googleMapsLinkForPosition(origin) : undefined,
      target: { lat: 37.7857, lng: -122.4011 },
      targetSet: !questionRequiresTarget({ kind }),
      distanceMiles: kind === 'tentacle' ? 1 : kind === 'thermometer' ? 3 : kind === 'radar' ? 0.25 : 1,
      direction: 'north',
      category,
      regionId,
    };
    draft.enabled = solo ? false : questionIsReady(draft);
    setSelectedConstraintId(id);
    setState((current) => ({
      ...current,
      constraints: [draft, ...current.constraints],
    }));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const question = questionNodesRef.current.get(id);
      if (question) question.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    }));
    if (needsOrigin && !origin) setMessage('Current location was not available. Set the question pin manually.');
  };

  const selectConstraint = (constraint: Constraint) => {
    setSelectedConstraintId(constraint.id);
  };

  const applyConstraintPosition = (constraint: Constraint, update: Partial<Constraint>, position: Position) => {
    const category = constraint.category ?? defaultCategory(constraint.kind);
    const derivedRegion =
      constraint.kind === 'matching-region' && category ? nearestPoi(category, position)?.id : constraint.regionId;
    patchConstraint(constraint.id, {
      ...update,
      ...('origin' in update ? { originSet: true } : {}),
      ...('target' in update ? { targetSet: true } : {}),
      regionId: derivedRegion,
    });
  };

  const setEligibility = (scope: 'station' | 'route', id: string, value: Eligibility | '') =>
    setState((current) => {
      const key = scope === 'station' ? 'stationStatuses' : 'routeStatuses';
      const statuses = { ...current[key] };
      if (value) statuses[id] = value;
      else delete statuses[id];
      return { ...current, [key]: statuses };
    });

  const setAllStationEligibility = (value: Eligibility | '') =>
    setState((current) => ({
      ...current,
      stationStatuses: {
        ...Object.fromEntries(Object.entries(current.stationStatuses).filter(([id]) => !scopedStationIds.has(id))),
        ...stationStatusesForAll(scopedStations.map((station) => station.id), value),
      },
    }));

  const setEveryQuestionEnabled = (enabled: boolean) =>
    setState((current) => ({
      ...current,
      constraints: setAllConstraintsEnabled(current.constraints, enabled)
        .map((constraint) => questionIsReady(constraint) ? constraint : { ...constraint, enabled: false }),
    }));

  const setAllRouteEligibility = (value: Eligibility | '') =>
    setState((current) => ({
      ...current,
      routeStatuses: {
        ...Object.fromEntries(Object.entries(current.routeStatuses).filter(([id]) => !scopedRouteIds.has(id))),
        ...statusesForAll(scopedRoutes.map((route) => route.id), value),
      },
    }));

  const setTransitScope = (transitScope: TransitScope) => {
    if (solo) return;
    setState((current) => ({
      ...current,
      transitScope,
      constraints: transitScope === 'primary'
        ? current.constraints.map((constraint) =>
          constraint.category === 'transit-route' && constraint.kind === 'matching-region' &&
          !primaryTransitRoutes.some((route) => route.id === constraint.regionId)
            ? { ...constraint, regionId: primaryTransitRoutes[0]?.id }
            : constraint)
        : current.constraints,
      layers: transitScope === 'primary'
        ? { ...current.layers, 'transit-routes': true, 'other-transit-routes': false }
        : current.layers,
    }));
    const nextStations = transitScope === 'primary'
      ? validStations.filter((station) => primaryTransitStationIds.includes(station.id))
      : validStations;
    setSelectedStation(nextStations[0]?.id ?? '');
    setMessage(transitScope === 'primary'
      ? `${nextStations.length} light-rail or Rapid Muni stations shown; Other transit is hidden.`
      : 'All transit stations and routes are shown again.');
  };

  const createManualReachRegion = (): ManualReachRegion => ({ id: crypto.randomUUID(), points: [] });

  const beginManualBoundaryEditing = () => {
    const existing = state.manualReachBoundary?.regions.map((region) => ({
      ...region,
      points: region.points.map((position) => ({ ...position })),
    })) ?? [];
    const regions = existing.length ? existing : [createManualReachRegion()];
    setManualBoundaryDraft(regions);
    setActiveBoundaryRegionId(regions[0].id);
    setManualBoundaryEditing(true);
    setFocusedStation(undefined);
    setTraceActive(false);
    setMessage('Boundary editing started. Tap the map to add researched edge points.');
    requestAnimationFrame(() => mapNode.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  };

  const patchManualReachRegion = (id: string, update: Partial<ManualReachRegion>) =>
    setManualBoundaryDraft((current) => current.map((region) => region.id === id ? { ...region, ...update } : region));

  const addManualReachRegion = () => {
    if (manualBoundaryDraft.length >= 20) {
      setMessage('A maximum of 20 disconnected boundary regions is supported.');
      return;
    }
    const region = createManualReachRegion();
    setManualBoundaryDraft((current) => [...current, region]);
    setActiveBoundaryRegionId(region.id);
  };

  const removeActiveManualReachRegion = () => {
    if (!activeBoundaryRegionId) return;
    const remaining = manualBoundaryDraft.filter((region) => region.id !== activeBoundaryRegionId);
    const regions = remaining.length ? remaining : [createManualReachRegion()];
    setManualBoundaryDraft(regions);
    setActiveBoundaryRegionId(regions[0].id);
  };

  const saveManualBoundary = () => {
    if (!manualBoundaryDraft.length || manualBoundaryDraft.some((region) => region.points.length < 3)) {
      setMessage('Each boundary region needs at least three map points. Remove empty regions or add more points.');
      return;
    }
    for (const region of manualBoundaryDraft) {
      const ring = [...region.points.map((position) => [position.lng, position.lat]), [region.points[0].lng, region.points[0].lat]];
      const polygon = turf.polygon([ring]);
      if (turf.kinks(polygon).features.length > 0) {
        setMessage('A boundary crosses itself. Undo or reorder its points before saving.');
        return;
      }
    }
    const regions = manualBoundaryDraft.map((region) => ({ id: region.id, points: region.points }));
    setState((current) => ({
      ...current,
      manualReachBoundary: {
        enabled: current.manualReachBoundary?.enabled ?? true,
        visible: true,
        regions,
      },
    }));
    setManualBoundaryEditing(false);
    setMessage('Maximum reach boundary saved and shown on the map.');
  };

  const fitManualBoundary = (regions: ManualReachRegion[]) => {
    if (!mapRef.current || regions.every((region) => region.points.length === 0)) return;
    const bounds = new google.maps.LatLngBounds();
    regions.forEach((region) => region.points.forEach((position) => bounds.extend(position)));
    mapRef.current.fitBounds(bounds, 48);
  };

  const fitTrace = () => {
    if (!mapRef.current || tracePoints.length === 0) return;
    const bounds = new google.maps.LatLngBounds();
    tracePoints.forEach((position) => bounds.extend(position));
    mapRef.current.fitBounds(bounds, 36);
  };

  const addHiderPositionToTrace = () => {
    if (!state.hiderPosition) {
      setMessage('Set the hider position first.');
      return;
    }
    setTracePoints((current) => [...current, state.hiderPosition!]);
  };

  const toggleTrace = () => {
    if (traceActive) {
      setTraceActive(false);
      return;
    }
    setTraceScreenshot(false);
    setTraceActive(true);
    requestAnimationFrame(() => mapNode.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  };

  const toggleTraceScreenshot = () => {
    const next = !traceScreenshot;
    setTraceScreenshot(next);
    setTraceActive(false);
    requestAnimationFrame(() => {
      if (mapRef.current) google.maps.event.trigger(mapRef.current, 'resize');
      if (next) fitTrace();
    });
  };

  const startSolo = async () => {
    if (!soloStartPosition) {
      setMessage('Set the Solo starting location first.');
      return;
    }
    try {
      setSoloBusy(true);
      const departureTime = sfLocalDateTimeToIso(soloDateTime);
      const transitScope = state.transitScope;
      const stationZoneMiles = state.stationZoneMiles;
      const response = await fetch('/api/solo/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          origin: soloStartPosition,
          departureTime,
          transitScope,
          hidingTimeMinutes: soloHidingTimeMinutes,
          stationZoneMiles,
        }),
      });
      const body = await response.json() as SoloStartResponse & { error?: string };
      if (!response.ok || !body.token) throw new Error(body.error ?? 'Xeno could not choose a hiding spot.');
      const boardState = {
        ...soloStateForNewGame({ ...state, transitScope }),
        viewport: { center: soloStartPosition, zoom: 13 },
      };
      const session: SoloClientSession = {
        ...body,
        createdAt: body.createdAt ?? new Date().toISOString(),
        startPosition: body.startPosition ?? soloStartPosition,
        questions: {},
        questionUses: body.questionUses ?? {},
        humanState: state,
        boardState,
      };
      setState(boardState);
      setSolo(session);
      setSoloPreview(undefined);
      setSoloAnswerSheet(undefined);
      setGameSummaryOpen(false);
      setSoloSetupOpen(false);
      setMenuOpen(false);
      mapRef.current?.panTo(soloStartPosition);
      mapRef.current?.setZoom(13);
      setMessage(`Xeno chose a reachable hiding zone using ${body.hidingTimeMinutes} minutes of hiding time and a ${body.stationZoneMiles}-mile radius. Seeking starts now.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Xeno could not start a Solo game.');
    } finally {
      setSoloBusy(false);
    }
  };

  const resetMapForMovement = (nextCardState?: SoloPublicCardState) => {
    if (!nextCardState || nextCardState.positionRevision <= (solo?.cardState?.positionRevision ?? 0)) return;
    setState((current) => ({
      ...current,
      constraints: current.constraints.map((existing) => ({ ...existing, enabled: false })),
      endGameActive: false,
      manualReachBoundary: current.manualReachBoundary
        ? { ...current.manualReachBoundary, enabled: false }
        : undefined,
    }));
    setSoloPreview(undefined);
  };

  const askSolo = async (constraint: Constraint) => {
    if (!solo || solo.questions[constraint.id]) return;
    try {
      setSoloPreview(undefined);
      setSoloAnswerSheet(undefined);
      setMessage('');
      setSoloBusy(true);
      const response = await fetch('/api/solo/question', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: solo.token, constraint }),
      });
      const body = await response.json() as {
        token?: string; answer?: Constraint['answer']; displayText?: string; resolvedRegionId?: string;
        photoUrl?: string; repetition?: number; cardsDrawn?: number; cardsKept?: number;
        totalCardsDrawn?: number; totalCardsKept?: number; phase?: SoloClientSession['phase']; error?: string;
        questionUses?: Record<string, number>;
        outcome?: SoloQuestionRecord['outcome']; playedCardAnnouncements?: string[]; cardState?: SoloPublicCardState;
        replacementConstraint?: Constraint; randomizedFrom?: string; randomizedTo?: string;
        geminiFallbackReason?: 'call-limit' | 'rate-limit' | 'budget' | 'unavailable' | 'error';
        geminiFallbackDetails?: string[];
      };
      body.geminiFallbackDetails?.forEach((detail) => {
        console.warn(`[Solo Gemini fallback] ${body.geminiFallbackReason ?? 'unknown'}: ${detail}`);
      });
      if (!response.ok || !body.token || !body.displayText || (body.outcome !== 'vetoed' && !body.answer)) throw new Error(body.error ?? 'Xeno could not answer.');
      const effectiveConstraint = body.replacementConstraint ?? constraint;
      if (body.outcome !== 'vetoed' && body.answer) patchConstraint(
        constraint.id,
        answeredSoloConstraint(constraint, body.replacementConstraint, body.answer, body.resolvedRegionId),
      );
      if (body.outcome === 'vetoed') patchConstraint(constraint.id, vetoedSoloConstraint(constraint));
      resetMapForMovement(body.cardState);
      const record: SoloQuestionRecord = {
        id: constraint.id,
        displayText: body.outcome === 'vetoed' ? body.displayText : publicSoloDisplayText(effectiveConstraint.kind, body.displayText),
        repetition: body.repetition ?? 1,
        cardsDrawn: body.cardsDrawn ?? 0,
        cardsKept: body.cardsKept ?? keptCardsForQuestion(effectiveConstraint, (body.repetition ?? 1) - 1),
        photoUrl: body.photoUrl,
        outcome: body.outcome,
        playedCards: body.playedCardAnnouncements,
        randomizedFrom: body.outcome === 'randomized' ? body.randomizedFrom || constraint.name || 'Original question' : undefined,
        randomizedTo: body.outcome === 'randomized' ? body.randomizedTo || effectiveConstraint.name || 'Replacement question' : undefined,
      };
      const fallbackMessage = body.geminiFallbackReason === 'rate-limit'
        ? 'Gemini’s per-minute limit was reached for this decision, so built-in strategy was used.'
        : body.geminiFallbackReason === 'error' || body.geminiFallbackReason === 'unavailable'
          ? 'Gemini was unavailable for this decision, so built-in strategy was used. It will try again next time.'
          : undefined;
      setSolo((current) => current ? {
        ...current,
        token: body.token!,
        cardsDrawn: body.totalCardsDrawn ?? current.cardsDrawn,
        cardsKept: body.totalCardsKept ?? current.cardsKept,
        questionUses: body.questionUses ?? current.questionUses ?? inferredUseCounts,
        phase: body.phase ?? current.phase,
        cardState: body.cardState ?? current.cardState,
        reveal: current.reveal?.reason === 'peek' ? undefined : current.reveal,
        questions: { ...current.questions, [constraint.id]: record },
      } : current);
      if (body.phase === 'end-game') setState((current) => ({ ...current, endGameActive: true }));
      setSoloAnswerSheet({ questionName: effectiveConstraint.name, record, fallbackMessage });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Xeno could not answer.');
    } finally {
      setSoloBusy(false);
    }
  };

  const applySoloResult = async (body: {
    token?: string; phase?: SoloClientSession['phase']; message?: string;
    reveal?: SoloClientSession['reveal']; cardState?: SoloPublicCardState; error?: string;
  }) => {
    if (!solo || !body.token || !body.phase) throw new Error(body.error ?? 'The Solo response was incomplete.');
    const reveal = body.reveal;
    resetMapForMovement(body.cardState);
    setSolo((current) => current ? {
      ...current,
      token: body.token!,
      phase: body.phase!,
      cardState: body.cardState ?? current.cardState,
      reveal: reveal ?? (current.reveal?.reason === 'peek' ? undefined : current.reveal),
      ...(reveal && reveal.reason !== 'peek' ? { pausedAt: undefined, totalPausedSeconds: reveal.pausedSeconds ?? current.totalPausedSeconds, pauseCount: reveal.pauseCount ?? current.pauseCount } : {}),
    } : current);
    if (body.phase === 'end-game' || body.phase === 'found') {
      setState((current) => ({ ...current, endGameActive: true }));
    }
    if (reveal && reveal.reason !== 'peek') setGameSummaryOpen(true);
    if (body.message) setMessage(body.message);
  };

  const sendSoloCardEvent = async (event:
    | { type: 'accept-pending' | 'reject-pending' | 'clear' | 'complete-task' | 'report-failure'; effectId: string }
    | { type: 'veto-infeasible'; effectId: string; reason: 'not-available' | 'unsafe' | 'closed' | 'other'; note?: string }
    | { type: 'hangman-guess'; effectId: string; guess: string }) => {
    if (!solo) return;
    try {
      setSoloBusy(true);
      const response = await fetch('/api/solo/card-event', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: solo.token, event }),
      });
      const body = await response.json() as { token?: string; phase?: SoloClientSession['phase']; cardState?: SoloPublicCardState; message?: string; error?: string };
      if (!response.ok || !body.token || !body.phase) throw new Error(body.error ?? 'Could not update the curse.');
      resetMapForMovement(body.cardState);
      setSolo((current) => current ? {
        ...current,
        token: body.token!,
        phase: body.phase!,
        cardState: body.cardState ?? current.cardState,
        reveal: current.reveal?.reason === 'peek' ? undefined : current.reveal,
      } : current);
      setHangmanGuess('');
      setMessage(body.message ?? 'Card state updated.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not update the curse.');
    } finally {
      setSoloBusy(false);
    }
  };

  const toggleSoloClock = async () => {
    if (!solo) return;
    try {
      setSoloBusy(true);
      const response = await fetch('/api/solo/clock', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: solo.token, action: solo.pausedAt ? 'resume' : 'pause' }),
      });
      const body = await response.json() as {
        token?: string;
        phase?: SoloClientSession['phase'];
        clock?: Pick<SoloClientSession, 'createdAt' | 'pausedAt' | 'totalPausedSeconds' | 'pauseCount'>;
        cardState?: SoloPublicCardState;
        message?: string;
        error?: string;
      };
      if (!response.ok || !body.token || !body.clock) throw new Error(body.error ?? 'Could not update the game timer.');
      setSolo((current) => current ? {
        ...current,
        ...body.clock,
        token: body.token!,
        phase: body.phase ?? current.phase,
        cardState: body.cardState ?? current.cardState,
      } : current);
      setSoloClock(Date.now());
      setMessage(body.message ?? (body.clock.pausedAt ? 'Game timer paused.' : 'Game timer resumed.'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not update the game timer.');
    } finally {
      setSoloBusy(false);
    }
  };

  const checkSoloPosition = async (position: Position) => {
    if (!solo) return;
    try {
      setSoloBusy(true);
      const response = await fetch('/api/solo/check-location', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: solo.token, position }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not check this location.');
      await applySoloResult(body);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not check this location.');
    } finally {
      setSoloBusy(false);
    }
  };

  const checkSoloCurrentLocation = () => {
    if (!navigator.geolocation) {
      setMessage('Location is unavailable. Open the pin fallback and paste your current Google Maps location.');
      return;
    }
    setSoloBusy(true);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => { setSoloBusy(false); void checkSoloPosition({ lat: coords.latitude, lng: coords.longitude }); },
      () => { setSoloBusy(false); setMessage('Location permission was denied. Use the Google Maps pin fallback.'); },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const revealSolo = async () => {
    if (!solo || !confirm('Reveal Xeno’s current location? The game will continue.')) return;
    try {
      setSoloBusy(true);
      const response = await fetch('/api/solo/reveal', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: solo.token }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not reveal the Solo location.');
      await applySoloResult(body);
      setMenuOpen(false);
      setMessage('Xeno’s current location has been revealed. The game is still active.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not reveal the Solo location.');
    } finally {
      setSoloBusy(false);
    }
  };

  const resignSolo = async () => {
    if (!solo || !confirm('Resign this Solo game? This ends the game and reveals Xeno.')) return;
    try {
      setSoloBusy(true);
      const response = await fetch('/api/solo/reveal', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: solo.token, resign: true }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not resign the Solo game.');
      await applySoloResult(body);
      setMenuOpen(false);
      setMessage('You resigned. Xeno’s hiding spot has been revealed.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not resign the Solo game.');
    } finally {
      setSoloBusy(false);
    }
  };

  const exitSolo = () => {
    if (!solo) return;
    if (solo.phase !== 'found' && solo.phase !== 'gave-up' && !confirm('Exit this Solo game? Its secret session will be discarded.')) return;
    setState(solo.humanState);
    setSolo(undefined);
    setMenuOpen(false);
    setFinishMapUrl('');
    setSoloPreview(undefined);
    setSoloAnswerSheet(undefined);
    setGameSummaryOpen(false);
    setMessage('Returned to the previous human-mode workspace.');
  };

  const share = async () => {
    const url = new URL(location.href);
    url.searchParams.set('config', encodeState(shareableState(state)));
    if (url.href.length > 4000) {
      setMessage('This map is still too detailed for a reliable text-message link. Reduce the manual boundary or remove old active map constraints, then share again.');
      return;
    }
    history.replaceState({}, '', url);
    if (navigator.share) {
      try {
        await navigator.share({ title: 'SF Hiding Area map', url: url.href });
        setMessage(solo ? 'Map shared without the Solo secret.' : 'Map shared without the private hider position.');
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          setMessage('Sharing canceled.');
          return;
        }
      }
    }
    try {
      await navigator.clipboard?.writeText(url.href);
      setMessage(solo ? 'Compact share URL copied. The Solo session and hiding secret were not included.' : 'Compact share URL copied. Your hider position was not included.');
    } catch {
      setMessage(solo ? 'Share URL is ready. The Solo session and hiding secret were not included.' : 'Share URL is ready in the address bar. Your hider position was not included.');
    }
  };

  const copySoloRevealPin = async () => {
    if (!solo?.reveal) return;
    try {
      await navigator.clipboard.writeText(`${solo.reveal.spot.lat}, ${solo.reveal.spot.lng}`);
      setMessage('Exact hiding coordinates copied.');
    } catch {
      setMessage('The hiding coordinates could not be copied.');
    }
  };

  const soloElapsed = solo ? elapsedSoloSeconds({
    createdAt: solo.createdAt || solo.departureTime,
    pausedAt: solo.pausedAt,
    totalPausedSeconds: solo.totalPausedSeconds,
  }, soloClock) : 0;
  const focusedStationData = focusedStation
    ? scopedStations.find((station) => station.id === focusedStation)
    : undefined;
  const soloAnswerCardActions = (soloAnswerSheet?.record.playedCards ?? []).filter((announcement) =>
    !(soloAnswerSheet?.record.outcome === 'randomized' && announcement.startsWith('Xeno played Randomize question')) &&
    !(soloAnswerSheet?.record.outcome === 'vetoed' && announcement.startsWith('Xeno played Veto question')));

  return (
    <main>
      <header>
        <div>
          <h1>SF Hiding Area</h1>
          <p>{solo ? 'Solo game · human seekers vs. Xeno.' : 'Rulebook-aware mapping for seekers and hiders.'}</p>
        </div>
        <div className="header-menu">
          <button className="menu-trigger" onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen} aria-label="Open game menu">•••</button>
          {menuOpen && <div className="menu-popover" role="menu">
            <button type="button" role="menuitem" onClick={() => { void share(); setMenuOpen(false); }}>Share map</button>
            {!solo && <button type="button" role="menuitem" onClick={() => { setSoloSetupOpen(true); setMenuOpen(false); }}>Start Solo game</button>}
            {solo && <button type="button" role="menuitem" onClick={revealSolo} disabled={solo.phase === 'found' || solo.phase === 'gave-up' || soloBusy}>Reveal</button>}
            {solo && <button type="button" role="menuitem" onClick={resignSolo} disabled={solo.phase === 'found' || solo.phase === 'gave-up' || soloBusy}>Resign</button>}
            {solo?.reveal && solo.reveal.reason !== 'peek' && <button type="button" role="menuitem" onClick={() => { setGameSummaryOpen(true); setMenuOpen(false); }}>View game summary</button>}
            {solo && <button type="button" role="menuitem" onClick={exitSolo}>Exit Solo</button>}
          </div>}
        </div>
      </header>
      {solo ? <nav className="solo-status" aria-label="Solo game status">
        <span><b>{solo.pausedAt ? 'Paused' : solo.phase === 'end-game' ? 'End game' : solo.phase === 'found' ? 'Found' : solo.phase === 'gave-up' ? 'Revealed' : 'Seeking'} · {formatElapsedTime(solo.reveal?.elapsedHidingSeconds ?? soloElapsed)}</b><small>{solo.cardState ? `${solo.cardState.handCount}/${solo.cardState.maxHandSize} hand · ${solo.cardState.deckCount} deck` : `${solo.cardsDrawn} drawn · ${solo.cardsKept} kept`}</small></span>
        <div className="solo-status-actions">
          <button type="button" className="secondary" onClick={() => void toggleSoloClock()} disabled={soloBusy || solo.phase === 'found' || solo.phase === 'gave-up'}>{solo.pausedAt ? 'Resume' : 'Pause'}</button>
          <button type="button" onClick={checkSoloCurrentLocation} disabled={soloBusy || Boolean(solo.pausedAt) || solo.phase === 'found' || solo.phase === 'gave-up'}>{soloBusy ? 'Checking…' : 'Check location'}</button>
        </div>
      </nav> : <>
        <nav className="mode-switch" aria-label="Player mode">
          <button className={state.mode === 'seeker' ? 'active' : ''} onClick={() => setState((current) => ({ ...current, mode: 'seeker' }))}>Seeker</button>
          <button className={state.mode === 'hider' ? 'active' : ''} onClick={() => setState((current) => ({ ...current, mode: 'hider' }))}>Hider answer helper</button>
        </nav>
        {state.endGameActive && <div className="human-endgame-status" role="status"><b>End game active</b><button type="button" className="secondary" onClick={() => setState((current) => ({ ...current, endGameActive: false }))}>Reset</button></div>}
      </>}
      <div className="layout">
        <aside aria-label="Question constraint controls">
          {solo && <details className="panel solo-panel" open={soloPanelOpen} onToggle={(event) => {
            if (event.target === event.currentTarget) setSoloPanelOpen(event.currentTarget.open);
          }}>
            <summary className="solo-panel-summary"><span>Xeno</span><small>{solo.phase === 'found' ? 'Found' : solo.phase === 'gave-up' ? 'Resigned' : `${solo.cardState?.handCount ?? 0} cards · ${soloVisibleCurses.length} curses`}</small></summary>
            <p className="helper">Xeno may move through legal card effects. Physical curse compliance and completion reports are honor-system based.</p>
            {solo.phase !== 'found' && solo.phase !== 'gave-up' && <p className="helper">When you think you’ve reached Xeno, choose “Check if we found the hider.” The game compares your device’s current position with Xeno’s hiding position.</p>}
            {solo.cardState && <>
              <details className="solo-hand">
                <summary><span>Private hand</span><b>{solo.cardState.handCount} / {solo.cardState.maxHandSize}</b></summary>
                {(solo.cardState.handCards ?? []).length ? <ul>{(solo.cardState.handCards ?? []).map((card) => <li key={card.id}>
                  <strong>{card.name}{card.count > 1 ? ` ×${card.count}` : ''}</strong>
                  <small>{card.kind === 'time-bonus' ? 'Time bonus' : card.kind === 'powerup' ? 'Power-up' : 'Curse'}</small>
                  <p>{card.description}</p>
                </li>)}</ul> : <p className="helper">Xeno’s hand is empty.</p>}
                <div className="solo-card-history">
                  <h3>Card moves</h3>
                  {solo.cardState.playHistory.length ? <ol>{solo.cardState.playHistory.map((move, index) => <li key={`${index}-${move}`}>{move}</li>)}</ol> : <p className="helper">No card moves yet.</p>}
                </div>
              </details>
              <dl><div><dt>Deck</dt><dd>{solo.cardState.deckCount}</dd></div><div><dt>Gemini calls</dt><dd>{solo.cardState.strategy.calls} / {solo.cardState.strategy.limit}</dd></div></dl>
              {solo.cardState.moves.length > 0 && <section className="solo-curses" aria-labelledby="solo-moves-title">
                <h3 id="solo-moves-title">Move reveals</h3>
                {solo.cardState.moves.map((move) => <article className="answer-result" key={move.at}>
                  <span>{new Date(move.at).toLocaleTimeString()} · immediate relocation</span>
                  <strong>{move.oldStation.name}</strong>
                  <a href={googleMapsLinkForPosition(move.oldStation.position)} target="_blank" rel="noreferrer">Open the revealed station pin</a>
                </article>)}
              </section>}
              {solo.cardState.strategy.fallback && (solo.cardState.strategy.fallbackReason === 'call-limit' || solo.cardState.strategy.fallbackReason === 'budget') && <p className="warning-line">{
                solo.cardState.strategy.fallbackReason === 'call-limit' ? 'Gemini call limit reached—using built-in strategy.'
                  : 'Gemini spending limit reached—using built-in strategy.'
              }</p>}
              <section className="solo-curses" aria-labelledby="solo-curses-title">
                <h3 id="solo-curses-title">Curses</h3>
                <p className="helper">When Xeno plays a curse, it appears here with its casting condition, instructions, timer, and clear or failure controls.</p>
                {soloVisibleCurses.length === 0 && <p className="empty-state">No pending or active curses.</p>}
                {soloVisibleCurses.map((effect) => {
                  const hangmanLocked = Boolean(effect.lockedUntil && Date.parse(effect.lockedUntil) > soloClock);
                  return <article className="answer-result" key={effect.id}>
                <span>{effect.status === 'pending' ? 'Casting condition pending' : effect.status === 'monitoring' ? 'Persistent condition being tracked' : effect.status === 'waiting' ? 'Required wait in progress' : effect.status === 'failed' ? 'Card condition reported' : 'Active curse'}</span>
                <strong>{effect.name}</strong>
                <p>{effect.description}</p>
                {effect.status === 'pending' && effect.castingInstruction && <p><b>Casting condition</b><br />{effect.castingInstruction}</p>}
                {effect.detail && <p><b>Card details</b><br />{effect.detail}</p>}
                <p><b>{effect.status === 'monitoring' ? 'Ongoing condition' : effect.status === 'failed' ? 'Resolution' : 'How this resolves'}</b><br />{effect.completionInstruction}</p>
                {effect.currentRestriction && <p className="warning-line"><b>{effect.currentRestriction}</b></p>}
                {effect.expiresAt && <p><b>Timer ends</b> · {new Date(effect.expiresAt).toLocaleTimeString()}</p>}
                {effect.lockedUntil && <p><b>Next Hangman attempt</b> · {new Date(effect.lockedUntil).toLocaleTimeString()}</p>}
                {effect.blocksTransit && <p className="warning-line"><b>Transportation is blocked until this curse resolves.</b></p>}
                {effect.placeName && <p><b>{effect.placeName}</b>{effect.citationUrl && <> · <a href={effect.citationUrl} target="_blank" rel="noreferrer">Google Maps source</a></>}</p>}
                {effect.imageUrl && <img src={effect.imageUrl} alt="Street View scene supplied by the curse" />}
                {effect.mazeSvg && <img className="solo-maze" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(effect.mazeSvg)}`} alt="Challenging maze to solve before clearing the curse" />}
                {effect.hangmanPattern && <><p className="proof">{effect.hangmanPattern}<br />Wrong: {effect.hangmanWrong?.join(', ') || 'none'}</p>{effect.status !== 'waiting' && <div className="map-place-actions"><input aria-label="Hangman guess" maxLength={5} disabled={hangmanLocked || Boolean(solo.pausedAt)} value={hangmanGuess} onChange={(event) => setHangmanGuess(event.target.value)} /><button type="button" disabled={soloBusy || hangmanLocked || Boolean(solo.pausedAt) || !hangmanGuess} onClick={() => void sendSoloCardEvent({ type: 'hangman-guess', effectId: effect.id, guess: hangmanGuess })}>{hangmanLocked ? 'Waiting to retry' : 'Guess'}</button></div>}</>}
                <div className="map-place-actions">
                  {effect.status === 'pending' && <><button type="button" className="keep" disabled={soloBusy || Boolean(solo.pausedAt)} onClick={() => void sendSoloCardEvent({ type: 'accept-pending', effectId: effect.id })}>Condition met</button><button type="button" className="secondary" disabled={soloBusy || Boolean(solo.pausedAt)} onClick={() => void sendSoloCardEvent({ type: 'reject-pending', effectId: effect.id })}>Condition not met</button></>}
                  {effect.canClear && <button type="button" className="keep" disabled={soloBusy || Boolean(solo.pausedAt)} onClick={() => void sendSoloCardEvent({ type: 'clear', effectId: effect.id })}>Task completed</button>}
                  {effect.canCompleteTask && <button type="button" className="keep" disabled={soloBusy || Boolean(solo.pausedAt)} onClick={() => void sendSoloCardEvent({ type: 'complete-task', effectId: effect.id })}>Initial task completed</button>}
                  {effect.canVetoInfeasible && <button type="button" className="secondary" disabled={soloBusy || Boolean(solo.pausedAt)} onClick={() => { setCurseVetoEffectId(effect.id); setCurseVetoReason('not-available'); setCurseVetoNote(''); }}>Can’t do this curse</button>}
                  {effect.canReportFailure && <button type="button" className="danger" disabled={soloBusy || Boolean(solo.pausedAt)} onClick={() => void sendSoloCardEvent({ type: 'report-failure', effectId: effect.id })}>{effect.failureInstruction ?? 'Report card condition'} · +{effect.failureBonusMinutes} min</button>}
                </div>
                </article>})}
              </section>
            </>}
            {solo.phase !== 'found' && solo.phase !== 'gave-up' && <details>
              <summary>Can’t share your device’s location? Use a Google Maps pin</summary>
              <p className="helper">Paste a Google Maps link for where you are. The game will compare that pin with Xeno’s hiding position instead of using your device’s location.</p>
              <MapLinkField label="Google Maps link for my current location" value={finishMapUrl} onChange={setFinishMapUrl} onResolved={(position) => void checkSoloPosition(position)} onMessage={setMessage} />
            </details>}
            {solo.reveal && <div className="solo-reveal">
              <h3>{solo.reveal.reason === 'found' ? 'Xeno found' : solo.reveal.reason === 'peek' ? 'Xeno’s current location' : 'Xeno’s hiding spot revealed'}</h3>
              {solo.reveal.reason === 'peek' && <><p className="helper">This is a snapshot of Xeno’s current location. Revealing it does not end or pause the game.</p><button type="button" className="secondary" onClick={() => setSolo((current) => current ? { ...current, reveal: undefined } : current)}>Hide reveal</button></>}
              <p className="helper"><b>Map markers:</b> ★ exact hiding spot · S central station</p>
              <p><b>Central station</b><br />{solo.reveal.station.name}</p>
              <div className="map-place-actions">
                <a href={googleMapsLinkForPosition(solo.reveal.station.position)} target="_blank" rel="noreferrer">Open central station pin</a>
              </div>
              <p><b>Hiding location</b></p>
              <img src={solo.reveal.panorama.imageUrl} alt="Street View at Xeno’s revealed hiding spot" />
              <div className="map-place-actions">
                <a href={googleMapsLinkForPosition(solo.reveal.spot)} target="_blank" rel="noreferrer">Open exact hiding pin</a>
                <button type="button" className="secondary" onClick={copySoloRevealPin}>Copy hiding coordinates</button>
              </div>
              <dl><div><dt>Departure</dt><dd>{new Date(solo.reveal.route.departureTime).toLocaleString()}</dd></div><div><dt>Arrival</dt><dd>{new Date(solo.reveal.route.arrivalTime).toLocaleString()}</dd></div><div><dt>Journey</dt><dd>{Math.round(solo.reveal.route.durationSeconds / 60)} min · {solo.reveal.route.summary.join(' → ')}</dd></div><div><dt>Imagery</dt><dd>{solo.reveal.panorama.date ?? 'date unavailable'}</dd></div></dl>
              {solo.reveal.timeBonusMinutes !== undefined && <><p><b>{solo.reveal.reason === 'peek' ? 'Current time-bonus total' : 'Final time-bonus score'}</b><br />{solo.reveal.timeBonusMinutes} minutes</p><p><b>Elapsed hiding time</b><br />{Math.floor((solo.reveal.elapsedHidingSeconds ?? 0) / 60)} minutes</p><details><summary>Movement and card history</summary>{solo.reveal.movementHistory?.map((move) => <p key={`${move.at}-${move.reason}`}><b>{move.reason}</b> · {move.station.name} · {new Date(move.at).toLocaleTimeString()}</p>)}<p><b>Played</b><br />{solo.reveal.cards?.played.join(', ') || 'None'}</p><p><b>Discarded</b><br />{solo.reveal.cards?.discarded.join(', ') || 'None'}</p><p><b>Remaining hand</b><br />{solo.reveal.cards?.remainingHand.join(', ') || 'Empty'}</p></details></>}
            </div>}
          </details>}
          {state.mode === 'hider' && (
            <section className="panel hider-panel">
              <h2>Hider position</h2>
              <p className="helper">Set your position once. Each question below will calculate the rulebook answer without sharing the position.</p>
              <MapLinkField
                label="My current Google Maps pin"
                value={state.hiderMapUrl ?? ''}
                onChange={(hiderMapUrl) => setState((current) => ({ ...current, hiderMapUrl }))}
                onResolved={(hiderPosition) => {
                  if (!isHidingPositionAllowed(hiderPosition)) {
                    setState((current) => ({ ...current, hiderPosition: undefined }));
                    setMessage('That pin is inside a no-hide zone. Choose another hiding position.');
                    return;
                  }
                  setState((current) => ({ ...current, hiderPosition }));
                  mapRef.current?.panTo(hiderPosition);
                }}
                onMessage={setMessage}
              />
              {state.hiderPosition && <p className="success-line">Position ready · omitted from shared URLs</p>}
              <div className="trace-tool">
                <h3>Trace a path</h3>
                <p className="helper">For “Trace nearest street/path,” start tracing and tap each bend on the map from intersection to intersection. When finished, open Screenshot view to remove the basemap and every other layer before capturing the trace. Trace data stays on this device and is omitted from shared URLs.</p>
                <p className="trace-stats"><b>{tracePoints.length}</b> points · <b>{traceDistanceMiles < 0.1 ? `${Math.round(traceDistanceMiles * 5280)} ft` : `${traceDistanceMiles.toFixed(2)} mi`}</b></p>
                <div className="trace-buttons">
                  <button type="button" className={traceActive ? 'danger' : 'keep'} onClick={toggleTrace}>{traceActive ? 'Finish tracing' : 'Start tracing'}</button>
                  <button type="button" className="secondary" disabled={tracePoints.length === 0} onClick={() => setTracePoints((current) => current.slice(0, -1))}>Undo point</button>
                  <button type="button" className="secondary" disabled={!state.hiderPosition} onClick={addHiderPositionToTrace}>Add my pin</button>
                  <button type="button" className="secondary" disabled={tracePoints.length === 0} onClick={fitTrace}>Fit trace</button>
                  <button type="button" className={traceScreenshot ? 'danger' : 'secondary'} disabled={tracePoints.length < 2} onClick={toggleTraceScreenshot}>{traceScreenshot ? 'Show map again' : 'Screenshot view'}</button>
                  <button type="button" className="danger" disabled={tracePoints.length === 0} onClick={() => { setTracePoints([]); setTraceActive(false); setTraceScreenshot(false); }}>Clear</button>
                </div>
                {traceActive && <p className="success-line">Tracing is active · tap the map to add the next point</p>}
                {traceScreenshot && <p className="success-line">Screenshot view is active · only the trace is visible on the map</p>}
              </div>
            </section>
          )}

          <details className="panel" open>
            <summary>Transit and map layers</summary>
            <label className="stacked">Transit game scope<select aria-label="Transit game scope" value={state.transitScope} disabled={Boolean(solo)} onChange={(event) => setTransitScope(event.target.value as TransitScope)}><option value="all">All transit</option><option value="primary">Light rail + Rapid only</option></select></label>
            {solo && <p className="helper">Transit scope is frozen for this Solo game.</p>}
            {state.transitScope === 'primary' && <p className="helper">Other-transit stations, routes, map lines, and controls are hidden in this mode.</p>}
            <div className="toggle-grid">
              <label className="toggle"><input type="checkbox" checked={state.layers['sticky-map'] !== false} onChange={(event) => setState((current) => ({ ...current, layers: { ...current.layers, 'sticky-map': event.target.checked } }))} />Sticky map while scrolling</label>
              <label className="toggle"><input type="checkbox" checked={!!state.layers['station-zones']} onChange={(event) => setState((current) => ({ ...current, layers: { ...current.layers, 'station-zones': event.target.checked } }))} />Hiding-zone radii</label>
              <label className="toggle"><input type="checkbox" checked={!!state.layers['transit-routes']} onChange={(event) => setState((current) => ({ ...current, layers: { ...current.layers, 'transit-routes': event.target.checked } }))} />Light rail + Rapid Muni</label>
              {state.transitScope === 'all' && <label className="toggle"><input type="checkbox" checked={!!state.layers['other-transit-routes']} onChange={(event) => setState((current) => ({ ...current, layers: { ...current.layers, 'other-transit-routes': event.target.checked } }))} />Other transit</label>}
              <label className="toggle"><input type="checkbox" checked={currentLocationVisible} onChange={(event) => setCurrentLocationVisible(event.target.checked)} />My current location</label>
            </div>
            <div className="inline-controls">
              <label>Hiding-zone radius (miles)<CommitNumberInput value={state.stationZoneMiles} min={0.05} max={5} step={0.05} onCommit={(stationZoneMiles) => setState((current) => ({ ...current, stationZoneMiles }))} /></label>
              <label>Area shading<select value={state.areaDisplayMode} onChange={(event) => setState((current) => ({ ...current, areaDisplayMode: event.target.value as AreaDisplayMode }))}><option value="excluded-red">Allowed transparent · excluded red</option><option value="allowed-green">Allowed green · excluded transparent</option></select></label>
            </div>
            <p className="helper">{eligibleIds.length} of {scopedStations.length} stations currently possible. A station turns off when its hiding-radius zone no longer overlaps the green feasible area; explicit station and route cuts also apply.</p>
            <p className="helper">The current-location layer stays on this device and is never included in shared URLs.</p>
            <p className="helper">Press and hold anywhere on the map—including shaded areas and markers—to drop a temporary pin, then open or copy its Google Maps link.</p>
          </details>

          <details className="panel manual-boundary-panel">
            <summary>Maximum reach research</summary>
            <p className="helper">The app does not calculate this boundary. Research the hider’s maximum reach yourself, then draw the result by tapping map points in order. Add another region for disconnected reachable areas.</p>
            {!manualBoundaryEditing ? <>
              {state.manualReachBoundary ? <>
                <div className="toggle-grid">
                  <label className="toggle"><input type="checkbox" checked={state.manualReachBoundary.enabled} onChange={(event) => setState((current) => current.manualReachBoundary ? { ...current, manualReachBoundary: { ...current.manualReachBoundary, enabled: event.target.checked } } : current)} />Apply to possible area</label>
                  <label className="toggle"><input type="checkbox" checked={state.manualReachBoundary.visible} onChange={(event) => setState((current) => current.manualReachBoundary ? { ...current, manualReachBoundary: { ...current.manualReachBoundary, visible: event.target.checked } } : current)} />Show outline</label>
                </div>
                <p className={state.manualReachBoundary.enabled ? 'success-line' : 'draft-status'}>{state.manualReachBoundary.enabled ? 'Boundary is constraining the possible area.' : 'Boundary is saved but not applied.'}</p>
                <div className="manual-boundary-summary">{state.manualReachBoundary.regions.map((region, index) => <div key={region.id}><b>Region {index + 1}</b><span>{region.points.length} points</span></div>)}</div>
              </> : <p className="empty-state">No researched boundary has been drawn.</p>}
              <div className="two-buttons manual-boundary-actions"><button type="button" className="keep" onClick={beginManualBoundaryEditing}>{state.manualReachBoundary ? 'Edit boundary' : 'Draw boundary'}</button><button type="button" className="secondary" disabled={!state.manualReachBoundary} onClick={() => state.manualReachBoundary && fitManualBoundary(state.manualReachBoundary.regions)}>Fit on map</button></div>
              {state.manualReachBoundary && <button type="button" className="danger full" onClick={() => { if (confirm('Clear the researched maximum reach boundary? This cannot be undone.')) setState((current) => ({ ...current, manualReachBoundary: undefined })); }}>Clear boundary</button>}
            </> : <>
              <p className="draft-status">Editing preview · map taps add points to the active region. The saved boundary is unchanged until you choose Save.</p>
              <div className="manual-region-toolbar">
                <label className="stacked">Active region<select value={activeBoundaryRegionId ?? ''} onChange={(event) => setActiveBoundaryRegionId(event.target.value)}>{manualBoundaryDraft.map((region, index) => <option value={region.id} key={region.id}>Region {index + 1} · {region.points.length} points</option>)}</select></label>
                <div className="two-buttons"><button type="button" className="secondary" onClick={addManualReachRegion}>Add region</button><button type="button" className="danger" onClick={removeActiveManualReachRegion}>Delete region</button></div>
              </div>
              {activeBoundaryRegion && <>
                <div className="manual-point-actions"><button type="button" className="secondary" disabled={!activeBoundaryRegion.points.length} onClick={() => patchManualReachRegion(activeBoundaryRegion.id, { points: activeBoundaryRegion.points.slice(0, -1) })}>Undo point</button><button type="button" className="secondary" disabled={!activeBoundaryRegion.points.length} onClick={() => patchManualReachRegion(activeBoundaryRegion.id, { points: [] })}>Clear region</button><button type="button" className="secondary" disabled={!manualBoundaryDraft.some((region) => region.points.length)} onClick={() => fitManualBoundary(manualBoundaryDraft)}>Fit preview</button></div>
              </>}
              <div className="two-buttons modal-actions"><button type="button" className="secondary" onClick={() => { setManualBoundaryEditing(false); setManualBoundaryDraft([]); setActiveBoundaryRegionId(undefined); setMessage('Boundary edits canceled.'); }}>Cancel</button><button type="button" className="keep" onClick={saveManualBoundary}>Save boundary</button></div>
            </>}
          </details>

          <details className="panel">
            <summary>Administrative, natural, and POI partitions</summary>
            <label className="stacked">Displayed partition<select aria-label="Displayed map partition" value={selectedPartitionLayer ?? ''} onChange={(event) => setState((current) => ({ ...current, layers: selectMapPartition(current.layers, event.target.value || undefined) }))}><option value="">Off</option><optgroup label="Administrative and natural">{GEOGRAPHIC_PARTITIONS.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}</optgroup><optgroup label="Points of interest">{VISIBLE_POI_PARTITIONS.map((category) => <option key={category} value={category}>{CATEGORY_LABELS[category]}</option>)}</optgroup></select></label>
            <label className="toggle"><input type="checkbox" checked={state.layers['partition-pins'] !== false} onChange={(event) => setState((current) => ({ ...current, layers: { ...current.layers, 'partition-pins': event.target.checked } }))} />Partition pins</label>
            <p className="helper">Only one partition is displayed at a time. Partition pins label districts, ZIP areas, landmasses, and POI sources; no-hide zones intentionally have no name pins. ZIP codes are generalized delivery areas, not official administrative districts. No-hide zones remain enforced in every game mode even when another partition is displayed.</p>
            {selectedPoiPartition && <><p className="helper">Numbered pins mark the selected POI sources; tap a pin or colored region to identify it.</p><div className="partition-key" role="list" aria-label={`${CATEGORY_LABELS[selectedPoiPartition]} map pin key`}>{selectedPartitionPois.map((poi, index) => <div className="legend" role="listitem" key={poi.id}><i className="pin-number" style={{ background: partitionColor(index, selectedPartitionPois.length) }}><span>{index + 1}</span></i><a href={poi.sourceMapUrl ?? googleMapsLinkForPosition(poi)} target="_blank" rel="noreferrer">{poi.name}</a><small>row {poi.sourceRow}</small></div>)}</div></>}
          </details>

          <details className="panel">
            <summary>Mark stations in / out</summary>
            <h3>All stations</h3>
            <div className="three-buttons" role="group" aria-label="Mark all stations">
              <button type="button" className="keep" onClick={() => setAllStationEligibility('in')}>Keep all in</button>
              <button type="button" className="danger" onClick={() => setAllStationEligibility('out')}>Cut all out</button>
              <button type="button" className="secondary" onClick={() => setAllStationEligibility('')}>Clear all</button>
            </div>
            <h3>One station</h3>
            <label className="stacked">Search stations<input className="mobile-scroll-target" type="search" value={stationSearch} onFocus={(event) => keepMobileFieldVisible(event.currentTarget)} onChange={(event) => setStationSearch(event.target.value)} placeholder="Type part of a station name" /></label>
            <p className="helper">{filteredStations.length} of {scopedStations.length} stations shown.</p>
            <label className="stacked">Station<select value={selectedStation} disabled={filteredStations.length === 0} onChange={(event) => { setSelectedStation(event.target.value); setFocusedStation(event.target.value || undefined); }}>{filteredStations.length === 0 && <option value="">No matching stations</option>}{filteredStations.map((station) => <option key={station.id} value={station.id}>{station.name}</option>)}</select></label>
            {selectedStation && <p className="helper">Services stopping here: {routesForStation(selectedStation).filter((routeId) => scopedRouteIds.has(routeId)).join(', ') || 'no mapped transit service'}</p>}
            <div className="three-buttons">
              <button type="button" className="keep" disabled={!selectedStation} onClick={() => setEligibility('station', selectedStation, 'in')}>Keep in</button>
              <button type="button" className="danger" disabled={!selectedStation} onClick={() => setEligibility('station', selectedStation, 'out')}>Cut out</button>
              <button type="button" className="secondary" disabled={!selectedStation} onClick={() => setEligibility('station', selectedStation, '')}>Clear</button>
            </div>
            <h3>Cut or keep an entire route</h3>
            <label className="stacked">All transit routes<select aria-label="All route eligibility" value={allRouteEligibility} onChange={(event) => setAllRouteEligibility(event.target.value as Eligibility | '')}><option value="">Unmarked all</option><option value="in">Keep all in</option><option value="out">Cut all out</option>{allRouteEligibility === 'mixed' && <option value="mixed" disabled>Mixed per-route settings</option>}</select></label>
            <div className="route-list">
              {scopedRoutes.map((route) => (
                <label key={route.id}><span><b>{route.id}</b><small>{transitModeLabel(route.mode)}</small></span><select aria-label={`${route.id} route eligibility`} value={state.routeStatuses[route.id] ?? ''} onChange={(event) => setEligibility('route', route.id, event.target.value as Eligibility | '')}><option value="">Unmarked</option><option value="in">Keep in</option><option value="out">Cut out</option></select></label>
              ))}
            </div>
          </details>

          <section className="questions">
            <div className="section-heading"><h2>Questions</h2></div>
            <div className="two-buttons bulk-question-buttons" role="group" aria-label="Enable or disable all questions">
              <button type="button" className="secondary" disabled={readyConstraints.length === 0 || readyConstraints.every((constraint) => constraint.enabled)} onClick={() => setEveryQuestionEnabled(true)}>Enable all complete</button>
              <button type="button" className="secondary" disabled={readyConstraints.length === 0 || readyConstraints.every((constraint) => !constraint.enabled)} onClick={() => setEveryQuestionEnabled(false)}>Disable all</button>
            </div>
            <div className="add"><select id="kind" aria-label="Question type">{PRIMARY_QUESTION_KINDS.map((kind) => <option key={kind} value={kind}>{QUESTION_DEFINITIONS[kind].label}</option>)}</select><button onClick={() => void add()}>Add</button></div>
            {state.constraints.map((constraint) => {
              const definition = QUESTION_DEFINITIONS[constraint.kind];
              const usesOrigin = questionRequiresOrigin(constraint);
              const usesTarget = questionRequiresTarget(constraint);
              const usesDistance = ['radar', 'thermometer', 'radius', 'closer', 'farther', 'intersection', 'exclusion'].includes(constraint.kind);
              const prescribedDistances = constraint.kind === 'radar' || constraint.kind === 'thermometer'
                ? RULEBOOK_DISTANCE_CHOICES[constraint.kind]
                : undefined;
              const selectedDistance = prescribedDistances?.find((distance) => distance === constraint.distanceMiles);
              const distanceChoice = selectedDistance === undefined ? 'custom' : String(selectedDistance);
              const usesCategory = ['matching-region', 'measuring', 'tentacle', 'photo-reference'].includes(constraint.kind);
              const category = constraint.category;
              const missingFields = missingQuestionFields(constraint);
              const questionReady = missingFields.length === 0;
              const askedRecord = solo?.questions[constraint.id];
              const randomizedFrom = askedRecord?.randomizedFrom ?? 'Original question';
              const randomizedTo = askedRecord?.randomizedTo ?? 'Replacement question';
              const categoryChoices = solo && constraint.kind === 'photo-reference' ? soloPhotoChoices : subjectChoices(constraint.kind);
              const questionNotes = solo && constraint.kind === 'photo-reference'
                ? category === 'trace-nearest-street-path'
                  ? ['Solo house rule: a precomputed nearest-street orientation approximates the required intersection-to-intersection trace.', 'North is up. The clue covers named DataSF streets, not every park or unnamed path.', 'The image contains no street name or coordinates and uses no runtime map or model call.']
                  : ['Solo house rule: Google Street View approximates a live hider photo.', 'Station cards use a panorama at the hiding station. Other supported cards use Xeno’s current hiding panorama, which may change after Move or Distant Cuisine.', 'The server never exposes a coordinate-bearing Google request URL.', 'If imagery becomes unavailable, “I cannot answer” remains a valid answer.']
                : definition.notes;
              const selectedSubject = categoryChoices.find((subject) => subject.id === category);
              const selectedPriorUses = priorUsesFor(constraint);
              const disablingCurse = soloVisibleCurses.find((effect) =>
                effect.disabledCategory === constraint.kind || effect.disabledQuestionKeys?.includes(canonicalQuestionKey(constraint)));
              const tentacleChoices = constraint.kind === 'tentacle' && category !== 'transit-route'
                ? pois.filter((poi) => poi.category === category && turf.distance([constraint.origin.lng, constraint.origin.lat], [poi.lng, poi.lat], { units: 'miles' }) <= (constraint.distanceMiles ?? 1))
                : [];
              const sourcePoi = constraint.regionId ? pois.find((poi) => poi.id === constraint.regionId) : undefined;
              const matchingSource = constraint.kind !== 'matching-region' ? undefined
                : category === 'station-name-length'
                  ? (() => { const station = nearestPoi('game-valid-station', constraint.origin); return station ? `${station.name} · ${normalizedStationNameLength(station.name)} characters` : undefined; })()
                  : category === 'street-path'
                    ? nearestStreet(constraint.origin)
                    : category === 'supervisor-district'
                      ? districtAt(constraint.origin)?.properties.name
                      : category === 'landmass'
                        ? landmassAt(constraint.origin)?.properties.name
                        : category === 'zip-code'
                          ? zipCodeAt(constraint.origin)?.properties.name
                        : sourcePoi?.name;
              const previewBranches = solo && !askedRecord ? soloPreviewBranches(constraint) : [];
              return (
                <article
                  ref={(node) => { if (node) questionNodesRef.current.set(constraint.id, node); else questionNodesRef.current.delete(constraint.id); }}
                  key={constraint.id}
                  className={constraint.kind === 'radar' && selectedConstraintId === constraint.id ? 'radar-preview-active' : undefined}
                  onClick={() => selectConstraint(constraint)}
                  onFocusCapture={() => selectConstraint(constraint)}
                >
                  <div className="constraint-heading"><input aria-label="Constraint name" value={constraint.name} disabled={!!askedRecord} onChange={(event) => patchConstraint(constraint.id, { name: event.target.value })} /><label className="enabled"><input type="checkbox" checked={constraint.enabled} disabled={!questionReady} onChange={(event) => patchConstraint(constraint.id, { enabled: event.target.checked })} />Enabled</label></div>
                  <p className="question-help">{definition.help}</p>
                  {!questionReady && <p className="draft-status">Draft disabled · add {missingFields.join(' and ')} to enable it.</p>}
                  {!askedRecord && disablingCurse && <p className="draft-status">Disabled by {disablingCurse.name}. Choose another question.</p>}
                  {state.mode === 'hider' && <div className={`answer-result ${(constraint.kind === 'endgame-confirmation' || (state.hiderPosition && questionReady)) ? '' : 'waiting'}`}><span>Hider answer</span><strong>{!questionReady ? 'Complete the draft first' : constraint.kind === 'endgame-confirmation' ? 'Record whether this pin is inside your hiding zone' : state.hiderPosition ? hiderAnswer(constraint, state.hiderPosition, regions) : 'Set your position above'}</strong></div>}
                  {askedRecord?.outcome === 'randomized' && <div className="answer-result randomized-result"><span>Xeno played Randomize question</span><p><s>{randomizedFrom}</s></p><strong>Replaced with: {randomizedTo}</strong></div>}
                  {askedRecord?.outcome === 'vetoed' && <div className="answer-result vetoed-result"><span>Xeno played Veto question</span><p><s>{constraint.name}</s></p><strong>No answer was given.</strong><p>The question counts as asked, no cards were drawn, and it does not affect the map.</p></div>}
                  {askedRecord && askedRecord.outcome !== 'vetoed' && <div className="answer-result"><span>{askedRecord.outcome === 'randomized' ? 'Xeno’s answer to replacement' : 'Xeno’s answer'} · drew {askedRecord.cardsDrawn} · kept {askedRecord.cardsKept}</span><strong>{askedRecord.displayText}</strong>{askedRecord.photoUrl && <img className="solo-photo" src={askedRecord.photoUrl} alt={constraint.kind === 'photo-reference' && constraint.category === 'you' ? 'Xeno selfie easter egg' : `${constraint.name} Street View answer`} onError={(event) => { event.currentTarget.hidden = true; setMessage('The photo could not be loaded. The text answer remains available.'); }} />}</div>}
                  {askedRecord?.playedCards?.filter((announcement) =>
                    !(askedRecord.outcome === 'randomized' && announcement.startsWith('Xeno played Randomize question')) &&
                    !(askedRecord.outcome === 'vetoed' && announcement.startsWith('Xeno played Veto question'))
                  ).map((announcement) => <div className="answer-result card-action-result" key={announcement}><span>Xeno card action</span><strong>{announcement}</strong></div>)}
                  <div className="control-grid">
                    {!solo && constraint.kind !== 'photo-reference' && <label>Recorded answer<select aria-label={`${constraint.name} answer`} value={constraint.answerSet === false ? '' : constraint.answer} onChange={(event) => patchConstraint(constraint.id, { answer: event.target.value as Constraint['answer'], answerSet: true })}>{constraint.kind === 'endgame-confirmation' && <option value="">Choose result</option>}{answerOptions(constraint.kind).map((answer) => <option key={answer} value={answer}>{constraint.kind === 'endgame-confirmation' ? answer === 'yes' ? 'Correct · inside zone' : 'Incorrect · outside zone' : answer === 'yes' && constraint.kind === 'tentacle' ? 'named POI' : answer}</option>)}</select></label>}
                    {prescribedDistances ? <>
                      <label className="wide">Card distance<select aria-label={`${constraint.name} card distance`} value={distanceChoice} disabled={!!askedRecord} onChange={(event) => patchConstraint(constraint.id, { distanceMiles: event.target.value === 'custom' ? undefined : Number(event.target.value) })}>
                        {prescribedDistances.map((distance) => <option key={distance} value={distance}>{askedChoiceLabel(formatQuestionDistance(distance), askedUsesFor({ kind: constraint.kind, distanceMiles: distance }))}</option>)}
                        <option value="custom">{askedChoiceLabel(
                          'Custom distance',
                          distanceChoice === 'custom' && Number.isFinite(constraint.distanceMiles)
                            ? askedUsesFor({ kind: constraint.kind, distanceMiles: constraint.distanceMiles })
                            : 0,
                        )}</option>
                      </select></label>
                      {distanceChoice === 'custom' && <label className="wide">Custom miles<CommitNumberInput ariaLabel={`${constraint.name} distance in miles`} disabled={!!askedRecord} value={constraint.distanceMiles} min={0.05} max={100} step={0.05} onCommit={(distanceMiles) => patchConstraint(constraint.id, { distanceMiles })} /></label>}
                    </> : usesDistance && <label>Miles<CommitNumberInput ariaLabel={`${constraint.name} distance in miles`} disabled={!!askedRecord} value={constraint.distanceMiles} min={0.05} max={100} step={0.05} onCommit={(distanceMiles) => patchConstraint(constraint.id, { distanceMiles })} /></label>}
                    {constraint.kind === 'direction' && <label>Direction<select value={constraint.direction} onChange={(event) => patchConstraint(constraint.id, { direction: event.target.value as Constraint['direction'] })}>{['north', 'south', 'east', 'west'].map((direction) => <option key={direction}>{direction}</option>)}</select></label>}
                    {usesCategory && <label className="wide">Subject<select value={category} disabled={!!askedRecord} onChange={(event) => { const nextCategory = event.target.value; const tentacleMiles = constraint.kind === 'tentacle' ? 1 : constraint.distanceMiles; patchConstraint(constraint.id, { category: nextCategory, regionId: nextCategory === 'transit-route' ? scopedRoutes[0]?.id : nearestPoi(nextCategory, constraint.origin)?.id, distanceMiles: constraint.kind === 'matching-region' ? undefined : tentacleMiles }); }}>{categoryChoices.map((item) => <option key={item.id} value={item.id}>{askedChoiceLabel(item.label, askedUsesFor({ kind: constraint.kind, category: item.id }))}</option>)}</select></label>}
                    {constraint.kind === 'matching-region' && category === 'transit-route' && <label className="wide">Seeker’s moving transit service<select value={constraint.regionId ?? ''} disabled={!!askedRecord} onChange={(event) => patchConstraint(constraint.id, { regionId: event.target.value })}>{scopedRoutes.map((route) => <option key={route.id} value={route.id}>{transitRouteLabel(route)}</option>)}</select></label>}
                    {!solo && constraint.kind === 'tentacle' && constraint.answer === 'yes' && <label className="wide">Named {category === 'transit-route' ? 'route' : 'POI'}<select value={constraint.regionId ?? ''} onChange={(event) => patchConstraint(constraint.id, { regionId: event.target.value })}><option value="">Choose the hider’s answer</option>{category === 'transit-route' ? primaryTransitRoutes.filter((route) => distanceToRoute(constraint.origin, route) <= (constraint.distanceMiles ?? 1)).map((route) => <option key={route.id} value={route.id}>{route.id} line</option>) : tentacleChoices.map((poi) => <option key={poi.id} value={poi.id}>{poi.name}</option>)}</select></label>}
                  </div>
                  {!askedRecord && constraint.kind === 'endgame-confirmation' && <p className="question-cost">Free to ask · a correct pin starts the end game; an incorrect pin makes the hider draw 1 penalty card.</p>}
                  {!askedRecord && solo && constraint.kind === 'photo-reference' && category === 'you' && <p className="question-cost">Easter egg · free to ask, with no cards drawn or kept.</p>}
                  {!askedRecord && solo?.cardState?.nextQuestionFree && constraint.kind !== 'endgame-confirmation' && <p className="question-cost">Next question is free because of Impressionable Consumer · Xeno draws and keeps no cards.</p>}
                  {!askedRecord && !solo?.cardState?.nextQuestionFree && !(solo && constraint.kind === 'photo-reference' && category === 'you') && constraint.kind !== 'endgame-confirmation' && definition.baseDrawCount !== undefined && definition.baseKeepCount !== undefined && <p className="question-cost">Next reward: draw {cardsForQuestion(constraint, selectedPriorUses) + (solo?.cardState?.nextRewardExtraDraw ?? 0)}, keep {keptCardsForQuestion(constraint, selectedPriorUses)}{solo?.cardState?.nextRewardExtraDraw ? ' · Overflowing Chalice adds one draw, not one keep' : ''}.</p>}
                  {constraint.kind === 'endgame-confirmation' && !solo && questionReady && <p className="derived">Recorded result: <b>{constraint.answer === 'yes' ? 'Correct — end game active; no cards drawn' : 'Incorrect — hider draws 1 penalty card'}</b></p>}
                  {constraint.kind === 'tentacle' && <p className="derived">Reach: <b>1 mile</b> · fixed by the card</p>}
                  {constraint.kind === 'matching-region' && category === 'transit-route' && <p className="derived">No distance applies. “Yes” keeps only stations where this service actually stops; “No” removes those stations.</p>}
                  {constraint.kind === 'matching-region' && category !== 'transit-route' && <p className="derived">Seeker’s match: <b>{constraint.originSet === false ? 'set the seeker pin' : matchingSource ?? 'set the seeker pin'}</b></p>}
                  {usesOrigin && !askedRecord && <MapLinkField label={constraint.kind === 'thermometer' ? 'Starting pin' : constraint.kind === 'endgame-confirmation' ? 'Pin believed to be inside the hiding zone' : 'Seeker pin'} value={constraint.originMapUrl ?? ''} onChange={(originMapUrl) => patchConstraint(constraint.id, { originMapUrl })} onResolved={(origin) => applyConstraintPosition(constraint, { origin }, origin)} onMessage={setMessage} />}
                  {usesTarget && !askedRecord && <MapLinkField label={constraint.kind === 'thermometer' ? 'Ending pin' : 'Comparison pin'} value={constraint.targetMapUrl ?? ''} onChange={(targetMapUrl) => patchConstraint(constraint.id, { targetMapUrl })} onResolved={(target) => applyConstraintPosition(constraint, { target }, target)} onMessage={setMessage} />}
                  {solo && !askedRecord && (previewBranches.length > 0 ? <div className="solo-preview-controls" aria-label={`Preview possible answers for ${constraint.name}`}>
                    <span>Preview on map · thinking tool only</span>
                    <div>{previewBranches.map((branch) => {
                      const active = soloPreview?.constraintId === constraint.id && soloPreview.answer === branch.answer;
                      return <button type="button" className={active ? 'active' : 'secondary'} aria-pressed={active} disabled={!questionReady} key={branch.answer} onClick={() => setSoloPreview(active ? undefined : { constraintId: constraint.id, answer: branch.answer, label: branch.label })}>{branch.label}</button>;
                    })}<button type="button" className="secondary" disabled={soloPreview?.constraintId !== constraint.id} onClick={() => setSoloPreview(undefined)}>Current map</button></div>
                  </div> : <p className="helper">This photo response does not create a geographic map cut.</p>)}
                  {solo && !askedRecord && <button type="button" className="full keep" disabled={!questionReady || soloBusy || Boolean(solo.pausedAt) || Boolean(disablingCurse) || solo.phase === 'found' || solo.phase === 'gave-up' || soloQuestionBlocked} onClick={() => void askSolo(constraint)}>{solo.pausedAt ? 'Resume the timer to ask' : soloQuestionBlocked ? 'Complete or resolve active curse first' : disablingCurse ? `Disabled by ${disablingCurse.name}` : soloBusy ? 'Xeno is answering…' : 'Ask Xeno'}</button>}
                  <details className="rule-notes"><summary>Rulebook notes</summary>{selectedSubject && <p className="support-line"><b>{selectedSubject.support === 'approximate' ? 'Approximate support' : selectedSubject.support === 'reference' ? 'Reference card' : selectedSubject.support === 'not-mapped' ? 'Returns “I cannot answer”' : 'Supported'}</b></p>}<ul>{orderedRuleNotes(constraint.kind, questionNotes, selectedSubject?.notes).map((note) => <li key={note}>{note}</li>)}</ul>{(definition.drawInstruction || definition.timeLimit) && <p>{definition.drawInstruction && <span><b>Hider cards after answering:</b> {definition.drawInstruction}</span>}{definition.timeLimit && <span><b>Answer time:</b> {definition.timeLimit}</span>}</p>}{definition.sourceUrl && <a href={definition.sourceUrl} target="_blank" rel="noreferrer">Open rulebook page</a>}</details>
                  {!askedRecord && <button className="danger remove" onClick={() => { if (soloPreview?.constraintId === constraint.id) setSoloPreview(undefined); setState((current) => ({ ...current, constraints: current.constraints.filter((candidate) => candidate.id !== constraint.id) })); }}>Remove question</button>}
                </article>
              );
            })}
          </section>

          <details className="panel legend-panel">
            <summary>Legend, data, and coverage</summary>
            <div className="legend-key"><span className="rail" />Light rail <span className="rapid" />Rapid Muni <span className="other-transit" />Other transit <span className="eligible" />Eligible station <span className="cut" />Cut station/route</div>
            <section className="storage-summary" aria-labelledby="storage-summary-title">
              <h3 id="storage-summary-title">Storage, refresh, and sharing</h3>
              <dl>
                <div><dt>Seeker ↔ Hider Helper</dt><dd>These are two views of one human workspace, not separate games. Switching modes carries the same questions, recorded answers, end-game status, station/route cuts, layers, and map viewport. The Hider Helper’s calculated answer is display-only and does not overwrite the recorded answer. Its private position remains available while this tab is open, but is hidden in Seeker mode and excluded from sharing.</dd></div>
                <div><dt>Draft questions</dt><dd>A new question remains disabled and does not change the map until every required pin and option has been set. The card lists what is missing and enables itself when the last required field is completed; after that, Enabled can be switched off or on normally. No map-center or private hider location is used as an active draft answer.</dd></div>
                <div><dt>Normal workspace</dt><dd>Most edits live only in this browser tab. A refresh restores the configuration currently in the URL; without a <code>config</code> value, it otherwise starts fresh. The manual maximum-reach boundary is additionally saved in this browser for the current URL so drawing, applying, hiding, or clearing it survives refresh. Merely switching between Seeker and Hider Helper does not write anything to the URL or server.</dd></div>
                <div><dt>Share URL</dt><dd>Choosing “Share map” creates a compact map-only snapshot and opens the device share sheet when available. It includes only active map-affecting constraints, visible/applied manual reach regions, station/route cuts, known layers, shading, radius, transit scope, and viewport. Pasted Maps URLs, custom question names and IDs, drafts, disabled questions, photo/end-game records, private hider state, current location, path traces, and the encrypted Solo session are omitted. Canonical pin links and question labels are regenerated when the map is restored.</dd></div>
                <div><dt>Solo game</dt><dd>The encrypted 48-hour session token, card totals, question history, Solo board, and pre-Solo workspace are saved in this browser’s local storage. Refreshing this browser resumes it; another person or browser does not share the game.</dd></div>
                <div><dt>Server</dt><dd>Solo requests are processed statelessly: the app has no game-session database. The server reads and replaces the encrypted token and calls Google for routing and Street View without putting the Solo secret in a share URL.</dd></div>
                <div><dt>Temporary location data</dt><dd>Current-location display, path traces, and a manually dropped map pin remain in page memory and disappear on refresh. A GPS or pasted finish pin is sent to the server only when checking the Solo hiding spot.</dd></div>
              </dl>
            </section>
            <p className="source">{provenance.totalPois.toLocaleString()} normalized POIs from <a href={provenance.sourceUrl}>the SF spreadsheet</a> · retrieved {provenance.retrieved}</p>
            <p className="source">Routes: <a href={transitProvenance.sourceUrl}>DataSF Muni Simple Routes</a> · scheduled station stops: <a href={stationRouteProvenance.sourceUrl}>SFMTA GTFS</a> · coastline: <a href={coastlineProvenance.sourceUrl}>DataSF SF Shoreline and Islands</a>.</p>
            <p className="source">Districts/water: <a href={rulebookAreaProvenance.districts.sourceUrl}>DataSF districts</a> / <a href={rulebookAreaProvenance.water.sourceUrl}>water bodies</a> · streets: <a href={streetProvenance.sourceUrl}>DataSF centerlines</a> · elevation: <a href={elevationProvenance.sourceUrl}>Mapzen terrain tiles</a>.</p>
            <p className="source">ZIP areas: <a href={rulebookAreaProvenance.zipCodes.sourceUrl}>DataSF San Francisco ZIP Codes</a> · {zipCodeAreas.features.length} merged regions.</p>
            <p className="source">No-hide zones: <a href={noHideZoneProvenance.sourceUrl}>SF game document blackout map</a> · three approximate regions buffered by {noHideZoneProvenance.bufferFeet} feet.</p>
            <p className="source">Interactive map coverage includes all in-play SF matching and measuring subjects. Approximate cards are labeled in their question notes. Photo cards are retained as reference because they do not determine a polygon. The map does not certify a final hiding spot: players must still confirm it is publicly accessible during game hours, safe, and within 10 feet of a marked path/road that the map app will use for walking directions.</p>
            {([['Matching', MATCHING_SUBJECTS], ['Measuring', MEASURING_SUBJECTS], ['Photos', PHOTO_SUBJECTS]] as const).map(([group, subjects]) => <details className="coverage-group" key={group}><summary>{group} deck audit · {subjects.filter((subject) => subject.status === 'in-play').length} in play</summary>{subjects.map((subject) => <p key={subject.id}><b>{subject.label}</b> · {subject.status === 'out-of-play' ? 'out of SF deck' : subject.support}</p>)}</details>)}
            {state.layers['supervisor-districts'] && supervisorDistricts.features.map((feature, index) => <div className="legend" key={feature.properties.id}><i style={{ background: partitionColor(index, supervisorDistricts.features.length, 15) }} /><span>{feature.properties.name}</span><small>DataSF</small></div>)}
            {state.layers['zip-codes'] && zipCodeAreas.features.map((feature, index) => <div className="legend" key={feature.properties.id}><i style={{ background: partitionColor(index, zipCodeAreas.features.length, 210) }} /><span>{feature.properties.name}</span><small>ZIP</small></div>)}
            {state.layers.landmasses && sfLandmasses.features.map((feature, index) => <div className="legend" key={feature.properties.id}><i style={{ background: partitionColor(index, sfLandmasses.features.length, 35) }} /><span>{feature.properties.name}</span><small>SF rule</small></div>)}
            {state.layers['no-hide-zones'] && <div className="legend"><i style={{ background: '#111827' }} /><span>No-hide zones</span><small>All games</small></div>}
          </details>
        </aside>
        <section className={`map-wrap${state.layers['sticky-map'] !== false && !traceScreenshot ? ' sticky-map' : ''}${traceScreenshot ? ' trace-screenshot' : ''}`} aria-label={traceScreenshot ? 'Trace-only screenshot view' : 'San Francisco feasible area map'}>
          {status !== 'ready' && <div className={`notice ${status}`} role="status">{status === 'loading' ? 'Loading map…' : message}</div>}
          <div ref={mapNode} className="map" />
          {manualBoundaryEditing && <div className="map-boundary-badge" role="status"><b>Drawing reach boundary</b><span>Tap map · Region {Math.max(1, manualBoundaryDraft.findIndex((region) => region.id === activeBoundaryRegionId) + 1)} · {activeBoundaryRegion?.points.length ?? 0} points</span></div>}
          {soloPreview && <div className="map-preview-badge" role="status"><b>Preview only</b><span>If Xeno answers {soloPreview.label}</span><button type="button" onClick={() => setSoloPreview(undefined)}>×</button></div>}
          {focusedStationData && <section className="station-map-sheet" aria-label={`Selected station ${focusedStationData.name}`}>
            <button type="button" className="station-sheet-close" aria-label="Close station controls" onClick={() => setFocusedStation(undefined)}>×</button>
            <span>{state.stationStatuses[focusedStationData.id] === 'in' ? 'Kept in' : state.stationStatuses[focusedStationData.id] === 'out' ? 'Cut out' : eligibleIds.includes(focusedStationData.id) ? 'Currently possible' : 'Eliminated by map questions'}</span>
            <strong>{focusedStationData.name}</strong>
            <p>{routesForStation(focusedStationData.id).filter((routeId) => scopedRouteIds.has(routeId)).join(', ') || 'No mapped transit service'} · lines highlighted</p>
            <div className="three-buttons">
              <button type="button" className="keep" onClick={() => setEligibility('station', focusedStationData.id, 'in')}>Keep in</button>
              <button type="button" className="danger" onClick={() => setEligibility('station', focusedStationData.id, 'out')}>Cut out</button>
              <button type="button" className="secondary" onClick={() => setEligibility('station', focusedStationData.id, '')}>Clear</button>
            </div>
          </section>}
          {traceScreenshot && <button type="button" className="trace-screenshot-exit" onClick={toggleTraceScreenshot} aria-label="Exit trace screenshot view" title="Show map again">×</button>}
          {state.mode === 'hider' && traceActive && <div className="trace-map-controls" role="toolbar" aria-label="Active path tracing controls"><span>{tracePoints.length} points · {traceDistanceMiles < 0.1 ? `${Math.round(traceDistanceMiles * 5280)} ft` : `${traceDistanceMiles.toFixed(2)} mi`}</span><button type="button" className="secondary" disabled={tracePoints.length === 0} onClick={() => setTracePoints((current) => current.slice(0, -1))}>Undo</button><button type="button" className="danger" onClick={() => setTraceActive(false)}>Finish</button></div>}
          <div className="attribution">POIs: linked SF dataset · routes/coast: DataSF · basemap © Google</div>
        </section>
      </div>
      {soloSetupOpen && <div className="modal-backdrop" role="presentation">
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="solo-setup-title">
          <h2 id="solo-setup-title">Start Solo game</h2>
          <p className="helper">Xeno will use walking and public transit to choose a hiding station reachable within the configured hiding time. Xeno may later move legally through card effects. Seeking begins immediately after the route is simulated.</p>
          <MapLinkField
            label="Starting location"
            value={soloStartMapUrl}
            onChange={setSoloStartMapUrl}
            onResolved={(position) => { setSoloStartPosition(position); mapRef.current?.panTo(position); }}
            onMessage={setMessage}
          />
          {soloStartPosition && <p className="success-line">Starting location ready</p>}
          <label className="stacked solo-datetime">Date and time · San Francisco<input type="datetime-local" value={soloDateTime} onChange={(event) => setSoloDateTime(event.target.value)} /></label>
          <label className="stacked">Hiding time (minutes)<CommitNumberInput value={soloHidingTimeMinutes} min={5} max={180} step={5} integer onCommit={setSoloHidingTimeMinutes} /></label>
          <label className="stacked">Hiding-zone radius (miles)<CommitNumberInput value={state.stationZoneMiles} min={0.05} max={5} step={0.05} onCommit={(stationZoneMiles) => setState((current) => ({ ...current, stationZoneMiles }))} /></label>
          <p className="helper">Google transit schedules support 7 days in the past through 100 days ahead.</p>
          <div className="two-buttons modal-actions">
            <button type="button" className="secondary" disabled={soloBusy} onClick={() => setSoloSetupOpen(false)}>Cancel</button>
            <button type="button" className="keep" disabled={soloBusy || !soloStartPosition} onClick={() => void startSolo()}>{soloBusy ? 'Finding a hiding spot…' : 'Start seeking'}</button>
          </div>
        </section>
      </div>}
      {solo && soloAnswerSheet && <div className="modal-backdrop solo-answer-backdrop" role="presentation">
        <section ref={soloAnswerSheetRef} className="modal solo-answer-sheet" role="dialog" aria-modal="true" aria-labelledby="solo-answer-title" tabIndex={-1} onKeyDown={(event) => { if (event.key === 'Escape') setSoloAnswerSheet(undefined); }}>
          <div className="solo-answer-heading"><span>{soloAnswerSheet.record.outcome === 'vetoed' ? 'Question vetoed' : 'Xeno answered'}</span><h2 id="solo-answer-title">{soloAnswerSheet.record.outcome === 'vetoed' ? 'No answer' : soloAnswerSheet.record.displayText}</h2><p>{soloAnswerSheet.questionName}</p></div>
          {soloAnswerSheet.record.outcome === 'randomized' && <div className="solo-answer-detail randomized-result"><b>Question replaced</b><p><s>{soloAnswerSheet.record.randomizedFrom}</s><br />→ {soloAnswerSheet.record.randomizedTo}</p></div>}
          {soloAnswerSheet.record.outcome === 'vetoed' ? <p className="solo-answer-detail">The question counts as asked, but Xeno gave no answer and received no card reward.</p> : <div className="solo-answer-stats"><span>Drew <b>{soloAnswerSheet.record.cardsDrawn}</b></span><span>Kept <b>{soloAnswerSheet.record.cardsKept}</b></span></div>}
          {soloAnswerSheet.record.photoUrl && <img className="solo-answer-photo" src={soloAnswerSheet.record.photoUrl} alt={`${soloAnswerSheet.questionName} answer`} onError={(event) => { event.currentTarget.hidden = true; setMessage('The photo could not be loaded. The text answer remains available.'); }} />}
          {soloAnswerCardActions.length > 0 && <section className="solo-answer-actions" aria-labelledby="solo-answer-actions-title"><h3 id="solo-answer-actions-title">Xeno also played</h3>{soloAnswerCardActions.map((announcement) => <p key={announcement}>{announcement}</p>)}</section>}
          {soloAnswerSheet.fallbackMessage && <p className="warning-line">{soloAnswerSheet.fallbackMessage}</p>}
          <button type="button" className="keep full solo-answer-continue" onClick={() => setSoloAnswerSheet(undefined)}>Continue</button>
        </section>
      </div>}
      {solo && curseVetoEffectId && <div className="modal-backdrop" role="presentation">
        <section className="modal curse-veto-modal" role="dialog" aria-modal="true" aria-labelledby="curse-veto-title">
          <h2 id="curse-veto-title">Can’t do this curse</h2>
          <p><b>{solo.cardState?.activeCurses.find((effect) => effect.id === curseVetoEffectId)?.name}</b></p>
          <p className="helper">This discards the curse with no bonus. Xeno’s curse cooldown still counts.</p>
          <label className="stacked">Reason<select value={curseVetoReason} onChange={(event) => setCurseVetoReason(event.target.value as typeof curseVetoReason)}><option value="not-available">Not available nearby</option><option value="unsafe">Unsafe or inaccessible</option><option value="closed">Closed, weather, or equipment</option><option value="other">Other</option></select></label>
          <label className="stacked">Optional note<textarea maxLength={200} value={curseVetoNote} onChange={(event) => setCurseVetoNote(event.target.value)} /></label>
          <div className="two-buttons modal-actions"><button type="button" className="secondary" onClick={() => setCurseVetoEffectId(undefined)}>Keep curse</button><button type="button" className="danger" disabled={soloBusy} onClick={() => { const effectId = curseVetoEffectId; setCurseVetoEffectId(undefined); void sendSoloCardEvent({ type: 'veto-infeasible', effectId, reason: curseVetoReason, note: curseVetoNote.trim() || undefined }); }}>Veto curse</button></div>
        </section>
      </div>}
      {solo && gameSummaryOpen && solo.reveal && solo.reveal.reason !== 'peek' && <div className="modal-backdrop game-summary-backdrop" role="presentation">
        <section className="modal game-summary" role="dialog" aria-modal="true" aria-labelledby="game-summary-title">
          <div className="summary-hero"><span aria-hidden="true">{solo.reveal.reason === 'found' ? '★' : '◆'}</span><div><h2 id="game-summary-title">{solo.reveal.reason === 'found' ? 'You found Xeno!' : 'Round ended'}</h2><p>{solo.reveal.reason === 'found' ? `Found in ${formatElapsedTime(solo.reveal.elapsedHidingSeconds ?? 0)}` : 'Xeno’s hiding spot has been revealed.'}</p></div></div>
          <div className="summary-score"><span>Final hider score</span><strong>{Math.floor((solo.reveal.elapsedHidingSeconds ?? 0) / 60) + (solo.reveal.timeBonusMinutes ?? 0)} min</strong><small>{Math.floor((solo.reveal.elapsedHidingSeconds ?? 0) / 60)} active + {solo.reveal.timeBonusMinutes ?? 0} bonus</small></div>
          <dl className="summary-stats"><div><dt>Active time</dt><dd>{formatElapsedTime(solo.reveal.elapsedHidingSeconds ?? 0)}</dd></div><div><dt>Paused</dt><dd>{formatElapsedTime(solo.reveal.pausedSeconds ?? 0)} · {solo.reveal.pauseCount ?? 0}×</dd></div><div><dt>Questions</dt><dd>{solo.reveal.questionsAsked ?? Object.keys(solo.questions).length}</dd></div><div><dt>Xeno vetoes</dt><dd>{solo.reveal.xenoVetoes ?? 0}</dd></div><div><dt>Randomized</dt><dd>{solo.reveal.randomizations ?? 0}</dd></div><div><dt>Moves</dt><dd>{solo.reveal.movementHistory?.filter((move) => move.reason !== 'initial').length ?? 0}</dd></div></dl>
          <section><h3>Curse and card review</h3>{solo.cardState?.playHistory.length ? <ol className="summary-history">{solo.cardState.playHistory.map((entry, index) => <li key={`${index}-${entry}`}>{entry}</li>)}</ol> : <p className="helper">No curse or card events were recorded.</p>}</section>
          <details><summary>Route and final location</summary><p><b>Original start</b><br />{(solo.startPosition ?? solo.reveal.station.position).lat.toFixed(5)}, {(solo.startPosition ?? solo.reveal.station.position).lng.toFixed(5)}</p><p><b>Central station</b><br />{solo.reveal.station.name}</p><p><b>Journey</b><br />{Math.round(solo.reveal.route.durationSeconds / 60)} min · {solo.reveal.route.summary.join(' → ')}</p><div className="map-place-actions"><a href={googleMapsLinkForPosition(solo.reveal.spot)} target="_blank" rel="noreferrer">Open final hiding pin</a></div></details>
          <div className="two-buttons modal-actions"><button type="button" className="secondary" onClick={() => setGameSummaryOpen(false)}>Back to map</button><button type="button" className="keep" onClick={exitSolo}>Exit Solo</button></div>
        </section>
      </div>}
      {message && status === 'ready' && <button className="toast" role="status" onClick={() => setMessage('')} aria-label="Dismiss message">{message}</button>}
    </main>
  );
}
