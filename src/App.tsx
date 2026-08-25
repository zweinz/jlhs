import { useEffect, useId, useMemo, useRef, useState } from 'react';
import * as turf from '@turf/turf';
import { setAllConstraintsEnabled, stationStatusesForAll, statusesForAll } from './bulkActions';
import { combineConstraints, excludedArea, nearestPoi, partition, stationIdsOverlappingArea } from './geometry';
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
import { activePoiPartition, selectPoiPartition, VISIBLE_POI_PARTITIONS } from './layers';
import { googleMapsLinkForPosition, resolveGoogleMapsLink } from './mapLinks';
import { orderedRuleNotes, PRIMARY_QUESTION_KINDS, QUESTION_DEFINITIONS } from './questions';
import {
  MATCHING_SUBJECTS,
  MEASURING_SUBJECTS,
  PHOTO_SUBJECTS,
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
import { decodeState, encodeState } from './share';
import {
  defaultSfDateTime,
  publicSoloDisplayText,
  sfLocalDateTimeToIso,
  SOLO_PHOTO_SUBJECTS,
  soloStateForNewGame,
  verifyRevealCommitment,
  type SoloClientSession,
  type SoloQuestionRecord,
  type SoloStartResponse,
} from './solo';
import {
  coastline,
  coastlineProvenance,
  distanceToRoute,
  eligibleStationIds,
  primaryTransitRoutes,
  primaryTransitStationIds,
  routesForStation,
  shouldDisplayStationZone,
  transitProvenance,
  transitRouteGeoJson,
  transitModeLabel,
  transitRouteLabel,
  transitRoutes,
  validStations,
} from './transit';
import type { AreaDisplayMode, Constraint, Eligibility, Position, QuestionKind, SharedState, TransitScope } from './types';
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
  coastline: false,
  'supervisor-districts': false,
  'zip-codes': false,
  landmasses: false,
};
const initial: SharedState = {
  version: 2,
  constraints: [],
  layers: initialLayers,
  viewport: { center: SF_CENTER, zoom: 12 },
  mode: 'seeker',
  stationZoneMiles: 0.25,
  areaDisplayMode: 'allowed-green',
  transitScope: 'all',
  stationStatuses: {},
  routeStatuses: {},
};
const partitionColor = (index: number, total: number, offset = 0) =>
  `hsl(${Math.round((index * 360) / Math.max(1, total) + offset) % 360}, 62%, 39%)`;
const measuringChoices = selectableSubjects(MEASURING_SUBJECTS);
const matchingChoices = selectableSubjects(MATCHING_SUBJECTS);
const photoChoices = selectableSubjects(PHOTO_SUBJECTS);
const soloPhotoChoices: RulebookSubject[] = SOLO_PHOTO_SUBJECTS.map((subject) => ({
  ...subject,
  status: 'in-play',
  support: 'reference',
  notes: ['Solo house rule: this image is generated from the AI hider’s committed outdoor Street View panorama.'],
}));

const SOLO_STORAGE_KEY = 'sf-hiding-area-solo-v1';

function restoredSolo(): SoloClientSession | undefined {
  try {
    const value = localStorage.getItem(SOLO_STORAGE_KEY);
    if (!value) return undefined;
    const session = JSON.parse(value) as SoloClientSession;
    const constraints = new Map(session.boardState.constraints.map((constraint) => [constraint.id, constraint]));
    session.questions = Object.fromEntries(Object.entries(session.questions).map(([id, record]) => {
      const constraint = constraints.get(id);
      return [id, constraint ? { ...record, displayText: publicSoloDisplayText(constraint.kind, record.displayText) } : record];
    }));
    return session;
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
    if (!payload) return initial;
    const restored = decodeState(payload);
    return { ...restored, layers: selectPoiPartition(restored.layers, activePoiPartition(restored.layers)) };
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
  const [busy, setBusy] = useState<'link' | 'location' | undefined>();
  const apply = async () => {
    try {
      setBusy('link');
      const resolved = await resolveGoogleMapsLink(value.trim());
      if (!insideSanFrancisco(resolved)) throw new Error('That pin is outside the San Francisco working bounds.');
      onResolved(resolved);
      onMessage(`${label} set from Google Maps.`);
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
    <div className="map-link-field">
      <label htmlFor={inputId}>{label}</label>
      <div className="map-link-input">
        <input
          id={inputId}
          type="url"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          placeholder="Paste a Google Maps link"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <button className="clear-link" type="button" disabled={!value || !!busy} onClick={clear} aria-label={`Clear ${label} link`} title="Clear link">×</button>
      </div>
      <div className="map-link-actions">
        <button className="secondary" type="button" disabled={!value.trim() || !!busy} onClick={apply}>
          {busy === 'link' ? 'Reading…' : 'Use link'}
        </button>
        <button className="secondary location-button" type="button" disabled={!!busy} onClick={useCurrentLocation}>
          {busy === 'location' ? 'Locating…' : 'Use current location'}
        </button>
      </div>
    </div>
  );
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
  label: id === 'transit-route' ? 'Metro line' : CATEGORY_LABELS[id as PoiCategory],
  status: 'in-play',
  support: id === 'transit-route' ? 'approximate' : 'exact',
  notes: [id === 'transit-route' || id === 'aquarium' ? 'Large-game card: 15-mile reach.' : 'Medium/large-game card: 1-mile reach.'],
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
  return 'yes';
}

export default function App() {
  const mapNode = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const drawn = useRef<google.maps.Data | null>(null);
  const [state, setState] = useState<SharedState>(() => initialSolo?.boardState ?? restoredState());
  const [solo, setSolo] = useState<SoloClientSession | undefined>(initialSolo);
  const [menuOpen, setMenuOpen] = useState(false);
  const [soloSetupOpen, setSoloSetupOpen] = useState(false);
  const [soloBusy, setSoloBusy] = useState(false);
  const [soloStartMapUrl, setSoloStartMapUrl] = useState('');
  const [soloStartPosition, setSoloStartPosition] = useState<Position | undefined>();
  const [soloDateTime, setSoloDateTime] = useState(() => defaultSfDateTime());
  const [finishMapUrl, setFinishMapUrl] = useState('');
  const [currentLocationVisible, setCurrentLocationVisible] = useState(false);
  const [currentLocation, setCurrentLocation] = useState<Position | undefined>();
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const [selectedStation, setSelectedStation] = useState(validStations[0]?.id ?? '');
  const [traceActive, setTraceActive] = useState(false);
  const [traceScreenshot, setTraceScreenshot] = useState(false);
  const [tracePoints, setTracePoints] = useState<Position[]>([]);

  const partitions = useMemo(
    () => Object.fromEntries(REGION_CATEGORIES.map((category) => [category, partition(category)])),
    [],
  ) as Record<PoiCategory, ReturnType<typeof partition>>;
  const selectedPoiPartition = activePoiPartition(state.layers);
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
  const feasible = useMemo(
    () => combineConstraints(state.constraints, regions),
    [regions, state.constraints],
  );
  const excluded = useMemo(() => excludedArea(feasible), [feasible]);
  const eligibleIds = useMemo(
    () => stationIdsOverlappingArea(statusEligibleIds, state.stationZoneMiles, feasible),
    [feasible, state.stationZoneMiles, statusEligibleIds],
  );
  const traceDistanceMiles = useMemo(
    () => pathDistanceMiles(tracePoints),
    [tracePoints],
  );

  useEffect(() => {
    if (!solo) {
      localStorage.removeItem(SOLO_STORAGE_KEY);
      return;
    }
    localStorage.setItem(SOLO_STORAGE_KEY, JSON.stringify({ ...solo, boardState: state }));
  }, [solo, state]);

  useEffect(() => {
    if (!scopedStations.some((station) => station.id === selectedStation)) {
      setSelectedStation(scopedStations[0]?.id ?? '');
    }
  }, [scopedStations, selectedStation]);

  useEffect(() => {
    if (!currentLocationVisible) return;
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
        mapRef.current?.panTo(position);
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
    const key = import.meta.env.VITE_GOOGLE_MAPS_BROWSER_API_KEY ?? import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
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
      if (mapRef.current === map) mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== 'ready' || !traceActive) return;
    const listener = map.addListener('click', (event: google.maps.MapMouseEvent) => {
      const latLng = event.latLng;
      if (!latLng) return;
      const next = { lat: latLng.lat(), lng: latLng.lng() };
      if (insideSanFrancisco(next)) setTracePoints((current) => [...current, next]);
    });
    return () => listener.remove();
  }, [status, traceActive]);

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
    if (state.mode !== 'hider' && traceScreenshot) setTraceScreenshot(false);
  }, [state.mode, traceScreenshot]);

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
        data.addGeoJson({
          type: 'Feature',
          properties: { kind: 'poi-source', color, id: poi.id, areaName: poi.name, number: index + 1 },
          geometry: { type: 'Point', coordinates: [poi.lng, poi.lat] },
        });
      });
    }
    const geographicPartitions = [
      { key: 'supervisor-districts', collection: supervisorDistricts, offset: 15 },
      { key: 'zip-codes', collection: zipCodeAreas, offset: 210 },
      { key: 'landmasses', collection: sfLandmasses, offset: 35 },
    ];
    geographicPartitions.filter(({ key }) => state.layers[key]).forEach(({ collection, offset }) => {
      collection.features.forEach((feature, index) => data.addGeoJson({
        ...feature,
        properties: { ...feature.properties, kind: 'geographic-region', color: partitionColor(index, collection.features.length, offset), areaName: feature.properties.name },
      }));
    });
    if (state.layers.coastline) {
      data.addGeoJson({ ...coastline, properties: { kind: 'coastline' } });
    }
    if (state.layers['transit-routes'] || (state.transitScope === 'all' && state.layers['other-transit-routes'])) {
      transitRouteGeoJson.features.filter((feature) =>
        feature.properties.mode === 'other-transit'
          ? state.transitScope === 'all' && state.layers['other-transit-routes']
          : state.layers['transit-routes'],
      ).forEach((feature) => {
        const routeStatus = state.routeStatuses[feature.properties.routeId];
        data.addGeoJson({ ...feature, properties: { ...feature.properties, kind: 'transit-route', status: routeStatus ?? '', areaName: transitRouteLabel(feature.properties) } });
      });
    }
    scopedStations.forEach((station) => {
      const eligible = eligibleIds.includes(station.id);
      const stationStatus = state.stationStatuses[station.id];
      data.addGeoJson({
        type: 'Feature',
        properties: { kind: 'station', id: station.id, status: stationStatus ?? '', eligible },
        geometry: { type: 'Point', coordinates: [station.lng, station.lat] },
      });
      if (shouldDisplayStationZone(state.layers['station-zones'], eligible)) {
        data.addGeoJson({
          ...turf.circle([station.lng, station.lat], state.stationZoneMiles, { units: 'miles', steps: 24 }),
          properties: { kind: 'station-zone', id: station.id, status: stationStatus ?? '', eligible },
        });
      }
    });
    if (currentLocationVisible && currentLocation) {
      data.addGeoJson({
        type: 'Feature',
        properties: { kind: 'current-location' },
        geometry: { type: 'Point', coordinates: [currentLocation.lng, currentLocation.lat] },
      });
    }
    const displayedArea = state.areaDisplayMode === 'excluded-red'
      ? { area: excluded, kind: 'excluded' }
      : { area: feasible, kind: 'feasible' };
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
      if (kind === 'excluded') return { fillColor: '#dc2626', fillOpacity: 0.28, strokeColor: '#991b1b', strokeWeight: 2, zIndex: 1 };
      if (kind === 'coastline') return { strokeColor: '#0284c7', strokeWeight: 4, fillOpacity: 0 };
      if (kind === 'hider-trace') return { strokeColor: '#e11d48', strokeOpacity: 0.95, strokeWeight: 5, zIndex: 20 };
      if (kind === 'trace-point') {
        const endpoint = feature.getProperty('endpoint');
        return { icon: { path: google.maps.SymbolPath.CIRCLE, fillColor: endpoint ? '#e11d48' : '#ffffff', fillOpacity: 1, strokeColor: '#e11d48', strokeWeight: 2, scale: endpoint ? 5 : 3 }, zIndex: 21 };
      }
      if (kind === 'current-location') {
        return {
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            fillColor: '#0ea5e9',
            fillOpacity: 1,
            strokeColor: '#ffffff',
            strokeWeight: 3,
            scale: 7,
          },
          zIndex: 40,
        };
      }
      if (kind === 'transit-route') {
        const mode = feature.getProperty('mode');
        return {
          strokeColor: routeStatus === 'out' ? '#b91c1c' : routeStatus === 'in' ? '#15803d' : mode === 'light-rail' ? '#7c3aed' : mode === 'rapid-muni' ? '#ea580c' : '#64748b',
          strokeOpacity: routeStatus === 'out' ? 0.48 : mode === 'other-transit' ? 0.58 : 0.82,
          strokeWeight: routeStatus ? 6 : mode === 'other-transit' ? 2.5 : 4,
        };
      }
      if (kind === 'station-zone') {
        const color = !eligible || routeStatus === 'out' ? '#b91c1c' : routeStatus === 'in' ? '#15803d' : '#2563eb';
        return { fillColor: color, fillOpacity: eligible ? 0.11 : 0.045, strokeColor: color, strokeOpacity: 0.58, strokeWeight: 1 };
      }
      if (kind === 'station' || kind === 'hider') {
        const isHider = kind === 'hider';
        const color = isHider ? '#111827' : !eligible || routeStatus === 'out' ? '#b91c1c' : routeStatus === 'in' ? '#15803d' : '#2563eb';
        return {
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            fillColor: color,
            fillOpacity: 1,
            strokeColor: '#ffffff',
            strokeWeight: 1.5,
            scale: isHider ? 7 : 3.7,
          },
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
      const colorValue = feature.getProperty('color');
      const regionColor = typeof colorValue === 'string' ? colorValue : '#553c9a';
      return { fillColor: regionColor, fillOpacity: kind === 'geographic-region' ? 0.07 : 0.14, strokeColor: regionColor, strokeWeight: kind === 'geographic-region' ? 2 : 1.5, zIndex: kind === 'region' ? 4 : 2 };
    });
    data.addListener('click', (event: google.maps.Data.MouseEvent) => {
      if (traceActive && event.latLng) {
        const next = { lat: event.latLng.lat(), lng: event.latLng.lng() };
        if (insideSanFrancisco(next)) setTracePoints((current) => [...current, next]);
        return;
      }
      const areaName = event.feature.getProperty('areaName');
      if (typeof areaName === 'string') setMessage(areaName);
    });
  }, [currentLocation, currentLocationVisible, eligibleIds, excluded, feasible, partitions, scopedStations, selectedPartitionPois, selectedPoiPartition, state.areaDisplayMode, state.hiderPosition, state.layers, state.mode, state.routeStatuses, state.stationStatuses, state.stationZoneMiles, state.transitScope, status, traceActive, tracePoints, traceScreenshot]);

  const patchConstraint = (id: string, update: Partial<Constraint>) =>
    setState((current) => ({
      ...current,
      constraints: current.constraints.map((constraint) =>
        constraint.id === id ? { ...constraint, ...update } : constraint,
      ),
    }));

  const add = () => {
    const kind = (document.querySelector('#kind') as HTMLSelectElement).value as QuestionKind;
    const category = solo && kind === 'photo-reference' ? 'cardinal-view' : defaultCategory(kind);
    const origin = state.viewport.center;
    const regionId = category ? nearestPoi(category, origin)?.id : undefined;
    setState((current) => ({
      ...current,
      constraints: [
        {
          id: crypto.randomUUID(),
          name: QUESTION_DEFINITIONS[kind].label,
          kind,
          enabled: true,
          answer: defaultAnswer(kind),
          origin,
          target: { lat: 37.7857, lng: -122.4011 },
          distanceMiles: kind === 'tentacle' ? 1 : kind === 'thermometer' ? 3 : kind === 'radar' ? 0.25 : 1,
          direction: 'north',
          category,
          regionId,
        },
        ...current.constraints,
      ],
    }));
  };

  const applyConstraintPosition = (constraint: Constraint, update: Partial<Constraint>, position: Position) => {
    const category = constraint.category ?? defaultCategory(constraint.kind);
    const derivedRegion =
      constraint.kind === 'matching-region' && category ? nearestPoi(category, position)?.id : constraint.regionId;
    patchConstraint(constraint.id, { ...update, regionId: derivedRegion });
    mapRef.current?.panTo(position);
    if ((mapRef.current?.getZoom() ?? 0) < 14) mapRef.current?.setZoom(14);
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
      constraints: setAllConstraintsEnabled(current.constraints, enabled),
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
      const response = await fetch('/api/solo/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ origin: soloStartPosition, departureTime }),
      });
      const body = await response.json() as SoloStartResponse & { error?: string };
      if (!response.ok || !body.token) throw new Error(body.error ?? 'The AI could not choose a hiding spot.');
      const boardState = {
        ...soloStateForNewGame(state),
        viewport: { center: soloStartPosition, zoom: 13 },
      };
      const session: SoloClientSession = {
        ...body,
        questions: {},
        humanState: state,
        boardState,
      };
      setState(boardState);
      setSolo(session);
      setSoloSetupOpen(false);
      setMenuOpen(false);
      mapRef.current?.panTo(soloStartPosition);
      mapRef.current?.setZoom(13);
      setMessage('The AI committed to a reachable hiding spot. Seeking starts now.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The AI could not start a Solo game.');
    } finally {
      setSoloBusy(false);
    }
  };

  const askSolo = async (constraint: Constraint) => {
    if (!solo || solo.questions[constraint.id]) return;
    try {
      setSoloBusy(true);
      const response = await fetch('/api/solo/question', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: solo.token, constraint }),
      });
      const body = await response.json() as {
        token?: string; answer?: Constraint['answer']; displayText?: string; resolvedRegionId?: string;
        photoUrl?: string; repetition?: number; cardsDrawn?: number; totalCardsDrawn?: number; error?: string;
      };
      if (!response.ok || !body.token || !body.answer || !body.displayText) throw new Error(body.error ?? 'The AI could not answer.');
      patchConstraint(constraint.id, { answer: body.answer, ...(body.resolvedRegionId ? { regionId: body.resolvedRegionId } : {}) });
      const record: SoloQuestionRecord = {
        id: constraint.id,
        displayText: publicSoloDisplayText(constraint.kind, body.displayText),
        repetition: body.repetition ?? 1,
        cardsDrawn: body.cardsDrawn ?? 0,
        photoUrl: body.photoUrl,
      };
      setSolo((current) => current ? {
        ...current,
        token: body.token!,
        cardsDrawn: body.totalCardsDrawn ?? current.cardsDrawn,
        questions: { ...current.questions, [constraint.id]: record },
      } : current);
      setMessage(`AI answered · drew ${record.cardsDrawn} card${record.cardsDrawn === 1 ? '' : 's'}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The AI could not answer.');
    } finally {
      setSoloBusy(false);
    }
  };

  const applySoloResult = async (body: {
    token?: string; phase?: SoloClientSession['phase']; message?: string;
    reveal?: SoloClientSession['reveal']; error?: string;
  }) => {
    if (!solo || !body.token || !body.phase) throw new Error(body.error ?? 'The Solo response was incomplete.');
    let reveal = body.reveal;
    if (reveal) reveal = { ...reveal, commitmentValid: await verifyRevealCommitment(reveal) };
    setSolo((current) => current ? { ...current, token: body.token!, phase: body.phase!, reveal: reveal ?? current.reveal } : current);
    if (body.message) setMessage(body.message);
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

  const giveUpSolo = async () => {
    if (!solo || !confirm('Give up and reveal the AI hider’s committed location?')) return;
    try {
      setSoloBusy(true);
      const response = await fetch('/api/solo/reveal', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: solo.token }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not reveal the Solo location.');
      await applySoloResult(body);
      setMessage('The AI hiding spot has been revealed.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not reveal the Solo location.');
    } finally {
      setSoloBusy(false);
    }
  };

  const exitSolo = () => {
    if (!solo) return;
    if (!solo.reveal && !confirm('Exit this Solo game? Its secret session will be discarded.')) return;
    setState(solo.humanState);
    setSolo(undefined);
    setMenuOpen(false);
    setFinishMapUrl('');
    setMessage('Returned to the previous human-mode workspace.');
  };

  const share = async () => {
    const url = new URL(location.href);
    const sourceState = solo?.humanState ?? state;
    const shareState = { ...sourceState, hiderPosition: undefined, hiderMapUrl: undefined };
    url.searchParams.set('config', encodeState(shareState));
    history.replaceState({}, '', url);
    try {
      await navigator.clipboard?.writeText(url.href);
      setMessage(solo ? 'Share URL copied. The Solo session and hiding secret were not included.' : 'Share URL copied. Your hider position was not included.');
    } catch {
      setMessage(solo ? 'Share URL is ready. The Solo session and hiding secret were not included.' : 'Share URL is ready in the address bar. Your hider position was not included.');
    }
  };

  return (
    <main>
      <header>
        <div>
          <h1>SF Hiding Area</h1>
          <p>{solo ? 'Solo game · human seekers vs. AI hider.' : 'Rulebook-aware mapping for seekers and hiders.'}</p>
        </div>
        <div className="header-menu">
          <button className="menu-trigger" onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen} aria-label="Open game menu">•••</button>
          {menuOpen && <div className="menu-popover" role="menu">
            <button type="button" role="menuitem" onClick={() => { void share(); setMenuOpen(false); }}>Share map</button>
            {!solo && <button type="button" role="menuitem" onClick={() => { setSoloSetupOpen(true); setMenuOpen(false); }}>Start Solo game</button>}
            {solo && <button type="button" role="menuitem" onClick={giveUpSolo} disabled={!!solo.reveal || soloBusy}>Give up & reveal</button>}
            {solo && <button type="button" role="menuitem" onClick={exitSolo}>Exit Solo</button>}
          </div>}
        </div>
      </header>
      {solo ? <nav className="solo-status" aria-label="Solo game status">
        <span><b>{solo.phase === 'end-game' ? 'End game' : solo.phase === 'found' ? 'Found' : solo.phase === 'gave-up' ? 'Revealed' : 'Seeking'}</b><small>{solo.cardsDrawn} cards drawn</small></span>
        <button type="button" onClick={checkSoloCurrentLocation} disabled={soloBusy || !!solo.reveal}>{soloBusy ? 'Checking…' : 'Check my location'}</button>
      </nav> : <nav className="mode-switch" aria-label="Player mode">
        <button className={state.mode === 'seeker' ? 'active' : ''} onClick={() => setState((current) => ({ ...current, mode: 'seeker' }))}>Seeker</button>
        <button className={state.mode === 'hider' ? 'active' : ''} onClick={() => setState((current) => ({ ...current, mode: 'hider' }))}>Hider answer helper</button>
      </nav>}
      <div className="layout">
        <aside aria-label="Question constraint controls">
          {solo && <section className="panel solo-panel">
            <h2>AI hider</h2>
            <p className="helper">The hiding spot is sealed by commitment <code>{solo.commitment.slice(0, 12)}…</code>. Questions use the normal small-game card costs; cards are counted but never drawn or played.</p>
            {!solo.reveal && <details>
              <summary>GPS fallback: check a pasted pin</summary>
              <MapLinkField label="My current Google Maps pin" value={finishMapUrl} onChange={setFinishMapUrl} onResolved={(position) => void checkSoloPosition(position)} onMessage={setMessage} />
            </details>}
            {solo.reveal && <div className="solo-reveal">
              <h3>{solo.reveal.reason === 'found' ? 'AI hider found' : 'Hiding spot revealed'}</h3>
              <p><b>{solo.reveal.station.name}</b></p>
              <p className={solo.reveal.commitmentValid ? 'success-line' : 'warning-line'}>{solo.reveal.commitmentValid ? 'Commitment verified — the location did not change.' : 'Commitment verification failed.'}</p>
              <img src={solo.reveal.panorama.imageUrl} alt="Street View at the revealed AI hiding spot" />
              <a href={googleMapsLinkForPosition(solo.reveal.spot)} target="_blank" rel="noreferrer">Open exact hiding pin</a>
              <dl><div><dt>Departure</dt><dd>{new Date(solo.reveal.route.departureTime).toLocaleString()}</dd></div><div><dt>Arrival</dt><dd>{new Date(solo.reveal.route.arrivalTime).toLocaleString()}</dd></div><div><dt>Journey</dt><dd>{Math.round(solo.reveal.route.durationSeconds / 60)} min · {solo.reveal.route.summary.join(' → ')}</dd></div><div><dt>Imagery</dt><dd>{solo.reveal.panorama.date ?? 'date unavailable'}</dd></div></dl>
              <details><summary>Verification proof</summary><code className="proof">{solo.reveal.commitment}</code><p className="helper">Session {solo.reveal.sessionId}<br />Salt {solo.reveal.salt}</p></details>
            </div>}
          </section>}
          {state.mode === 'hider' && (
            <section className="panel hider-panel">
              <h2>Hider position</h2>
              <p className="helper">Set your position once. Each question below will calculate the rulebook answer without sharing the position.</p>
              <MapLinkField
                label="My current Google Maps pin"
                value={state.hiderMapUrl ?? ''}
                onChange={(hiderMapUrl) => setState((current) => ({ ...current, hiderMapUrl }))}
                onResolved={(hiderPosition) => {
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
            <div className="toggle-grid">
              <label className="toggle"><input type="checkbox" checked={!!state.layers['station-zones']} onChange={(event) => setState((current) => ({ ...current, layers: { ...current.layers, 'station-zones': event.target.checked } }))} />Hiding-zone radii</label>
              <label className="toggle"><input type="checkbox" checked={!!state.layers['transit-routes']} onChange={(event) => setState((current) => ({ ...current, layers: { ...current.layers, 'transit-routes': event.target.checked } }))} />Light rail + Rapid Muni</label>
              {state.transitScope === 'all' && <label className="toggle"><input type="checkbox" checked={!!state.layers['other-transit-routes']} onChange={(event) => setState((current) => ({ ...current, layers: { ...current.layers, 'other-transit-routes': event.target.checked } }))} />Other transit</label>}
              <label className="toggle"><input type="checkbox" checked={!!state.layers.coastline} onChange={(event) => setState((current) => ({ ...current, layers: { ...current.layers, coastline: event.target.checked } }))} />Coastline</label>
              <label className="toggle"><input type="checkbox" checked={currentLocationVisible} onChange={(event) => setCurrentLocationVisible(event.target.checked)} />My current location</label>
            </div>
            <div className="inline-controls">
              <label>Hiding-zone radius (miles)<input type="number" min="0.05" max="5" step="0.05" value={state.stationZoneMiles} onChange={(event) => setState((current) => ({ ...current, stationZoneMiles: Math.max(0.05, Number(event.target.value) || 0.25) }))} /></label>
              <label>Area shading<select value={state.areaDisplayMode} onChange={(event) => setState((current) => ({ ...current, areaDisplayMode: event.target.value as AreaDisplayMode }))}><option value="allowed-green">Allowed green · excluded transparent</option><option value="excluded-red">Allowed transparent · excluded red</option></select></label>
            </div>
            <p className="helper">{eligibleIds.length} of {scopedStations.length} stations currently possible. A station turns off when its hiding-radius zone no longer overlaps the green feasible area; explicit station and route cuts also apply.</p>
            <p className="helper">The current-location layer stays on this device and is never included in shared URLs.</p>
          </details>

          <details className="panel">
            <summary>Administrative and natural partitions</summary>
            <div className="toggle-grid">
              <label className="toggle"><input type="checkbox" checked={!!state.layers['supervisor-districts']} onChange={(event) => setState((current) => ({ ...current, layers: { ...current.layers, 'supervisor-districts': event.target.checked } }))} />Supervisorial districts D1–D11</label>
              <label className="toggle"><input type="checkbox" checked={!!state.layers['zip-codes']} onChange={(event) => setState((current) => ({ ...current, layers: { ...current.layers, 'zip-codes': event.target.checked } }))} />ZIP-code areas</label>
              <label className="toggle"><input type="checkbox" checked={!!state.layers.landmasses} onChange={(event) => setState((current) => ({ ...current, layers: { ...current.layers, landmasses: event.target.checked } }))} />SF landmasses</label>
            </div>
            <p className="helper">Tap a displayed region to identify it. ZIP codes are generalized delivery areas, not official administrative districts.</p>
          </details>

          <details className="panel">
            <summary>Mark stations in / out</summary>
            <label className="stacked">Transit game scope<select aria-label="Transit game scope" value={state.transitScope} onChange={(event) => setTransitScope(event.target.value as TransitScope)}><option value="all">All transit</option><option value="primary">Light rail + Rapid only</option></select></label>
            {state.transitScope === 'primary' && <p className="helper">Other-transit stations, routes, map lines, and controls are hidden in this mode.</p>}
            <h3>All stations</h3>
            <div className="three-buttons" role="group" aria-label="Mark all stations">
              <button type="button" className="keep" onClick={() => setAllStationEligibility('in')}>Keep all in</button>
              <button type="button" className="danger" onClick={() => setAllStationEligibility('out')}>Cut all out</button>
              <button type="button" className="secondary" onClick={() => setAllStationEligibility('')}>Clear all</button>
            </div>
            <h3>One station</h3>
            <label className="stacked">Station<select value={selectedStation} onChange={(event) => setSelectedStation(event.target.value)}>{scopedStations.map((station) => <option key={station.id} value={station.id}>{station.name}</option>)}</select></label>
            {selectedStation && <p className="helper">Lines nearby: {routesForStation(selectedStation).filter((routeId) => scopedRouteIds.has(routeId)).join(', ') || 'no mapped transit-line match'}</p>}
            <div className="three-buttons">
              <button type="button" className="keep" onClick={() => setEligibility('station', selectedStation, 'in')}>Keep in</button>
              <button type="button" className="danger" onClick={() => setEligibility('station', selectedStation, 'out')}>Cut out</button>
              <button type="button" className="secondary" onClick={() => setEligibility('station', selectedStation, '')}>Clear</button>
            </div>
            <h3>Cut or keep an entire route</h3>
            <label className="stacked">All transit routes<select aria-label="All route eligibility" value={allRouteEligibility} onChange={(event) => setAllRouteEligibility(event.target.value as Eligibility | '')}><option value="">Unmarked all</option><option value="in">Keep all in</option><option value="out">Cut all out</option>{allRouteEligibility === 'mixed' && <option value="mixed" disabled>Mixed per-route settings</option>}</select></label>
            <div className="route-list">
              {scopedRoutes.map((route) => (
                <label key={route.id}><span><b>{route.id}</b><small>{transitModeLabel(route.mode)}</small></span><select aria-label={`${route.id} route eligibility`} value={state.routeStatuses[route.id] ?? ''} onChange={(event) => setEligibility('route', route.id, event.target.value as Eligibility | '')}><option value="">Unmarked</option><option value="in">Keep in</option><option value="out">Cut out</option></select></label>
              ))}
            </div>
          </details>

          <details className="panel">
            <summary>POI partition layers</summary>
            <label className="stacked">Displayed partition<select aria-label="POI partition layer" value={selectedPoiPartition ?? ''} onChange={(event) => setState((current) => ({ ...current, layers: selectPoiPartition(current.layers, (event.target.value || undefined) as PoiCategory | undefined) }))}><option value="">Off</option>{VISIBLE_POI_PARTITIONS.map((category) => <option key={category} value={category}>{CATEGORY_LABELS[category]}</option>)}</select></label>
            <p className="helper">Only one POI partition is shown at a time. Numbered pins mark the source POIs; tap a pin or colored region to identify it.</p>
            {selectedPoiPartition && <div className="partition-key" role="list" aria-label={`${CATEGORY_LABELS[selectedPoiPartition]} map pin key`}>{selectedPartitionPois.map((poi, index) => <div className="legend" role="listitem" key={poi.id}><i className="pin-number" style={{ background: partitionColor(index, selectedPartitionPois.length) }}><span>{index + 1}</span></i><a href={poi.sourceMapUrl ?? googleMapsLinkForPosition(poi)} target="_blank" rel="noreferrer">{poi.name}</a><small>row {poi.sourceRow}</small></div>)}</div>}
          </details>

          <section className="questions">
            <div className="section-heading"><h2>Questions</h2></div>
            <div className="two-buttons bulk-question-buttons" role="group" aria-label="Enable or disable all questions">
              <button type="button" className="secondary" disabled={state.constraints.length === 0 || state.constraints.every((constraint) => constraint.enabled)} onClick={() => setEveryQuestionEnabled(true)}>Enable all</button>
              <button type="button" className="secondary" disabled={state.constraints.length === 0 || state.constraints.every((constraint) => !constraint.enabled)} onClick={() => setEveryQuestionEnabled(false)}>Disable all</button>
            </div>
            <div className="add"><select id="kind" aria-label="Question type">{PRIMARY_QUESTION_KINDS.map((kind) => <option key={kind} value={kind}>{QUESTION_DEFINITIONS[kind].label}</option>)}</select><button onClick={add}>Add</button></div>
            {state.constraints.length === 0 && <p className="empty-state">Add a question, then paste the Google Maps links the players shared.</p>}
            {state.constraints.map((constraint) => {
              const definition = QUESTION_DEFINITIONS[constraint.kind];
              const usesOrigin = constraint.kind !== 'photo-reference' && !(constraint.kind === 'matching-region' && constraint.category === 'transit-route');
              const usesTarget = ['thermometer', 'closer', 'farther'].includes(constraint.kind);
              const usesDistance = ['radar', 'thermometer', 'radius', 'tentacle', 'closer', 'farther', 'intersection', 'exclusion'].includes(constraint.kind) || (constraint.kind === 'matching-region' && constraint.category === 'transit-route');
              const usesCategory = ['matching-region', 'measuring', 'tentacle', 'photo-reference'].includes(constraint.kind);
              const category = constraint.category;
              const askedRecord = solo?.questions[constraint.id];
              const categoryChoices = solo && constraint.kind === 'photo-reference' ? soloPhotoChoices : subjectChoices(constraint.kind);
              const questionNotes = solo && constraint.kind === 'photo-reference'
                ? ['Solo house rule: Google Street View replaces a live hider photo.', 'The server uses the committed outdoor panorama and never exposes its coordinate-bearing Google request URL.', 'If imagery becomes unavailable, “I cannot answer” remains a valid answer.']
                : definition.notes;
              const selectedSubject = categoryChoices.find((subject) => subject.id === category);
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
              return (
                <article key={constraint.id}>
                  <div className="constraint-heading"><input aria-label="Constraint name" value={constraint.name} disabled={!!askedRecord} onChange={(event) => patchConstraint(constraint.id, { name: event.target.value })} /><label className="enabled"><input type="checkbox" checked={constraint.enabled} onChange={(event) => patchConstraint(constraint.id, { enabled: event.target.checked })} />Enabled</label></div>
                  <p className="question-help">{definition.help}</p>
                  {state.mode === 'hider' && <div className={`answer-result ${state.hiderPosition ? '' : 'waiting'}`}><span>Hider answer</span><strong>{state.hiderPosition ? hiderAnswer(constraint, state.hiderPosition, regions) : 'Set your position above'}</strong></div>}
                  {askedRecord && <div className="answer-result"><span>AI answer · use {askedRecord.repetition} · drew {askedRecord.cardsDrawn}</span><strong>{askedRecord.displayText}</strong>{askedRecord.photoUrl && <img className="solo-photo" src={askedRecord.photoUrl} alt={`${constraint.name} Street View answer`} />}</div>}
                  <div className="control-grid">
                    {!solo && constraint.kind !== 'photo-reference' && <label>Recorded answer<select aria-label={`${constraint.name} answer`} value={constraint.answer} onChange={(event) => patchConstraint(constraint.id, { answer: event.target.value as Constraint['answer'] })}>{answerOptions(constraint.kind).map((answer) => <option key={answer} value={answer}>{answer === 'yes' && constraint.kind === 'tentacle' ? 'named POI' : answer}</option>)}</select></label>}
                    {usesDistance && <label>Miles<input aria-label={`${constraint.name} distance in miles`} disabled={!!askedRecord} type="number" min="0.05" step="0.05" value={constraint.distanceMiles} onChange={(event) => patchConstraint(constraint.id, { distanceMiles: Number(event.target.value) })} /></label>}
                    {constraint.kind === 'direction' && <label>Direction<select value={constraint.direction} onChange={(event) => patchConstraint(constraint.id, { direction: event.target.value as Constraint['direction'] })}>{['north', 'south', 'east', 'west'].map((direction) => <option key={direction}>{direction}</option>)}</select></label>}
                    {usesCategory && <label className="wide">Subject<select value={category} disabled={!!askedRecord} onChange={(event) => { const nextCategory = event.target.value; const tentacleMiles = constraint.kind === 'tentacle' ? (nextCategory === 'transit-route' || nextCategory === 'aquarium' ? 15 : 1) : constraint.distanceMiles; patchConstraint(constraint.id, { category: nextCategory, regionId: nextCategory === 'transit-route' ? (constraint.kind === 'tentacle' ? primaryTransitRoutes[0]?.id : scopedRoutes[0]?.id) : nearestPoi(nextCategory, constraint.origin)?.id, distanceMiles: constraint.kind === 'matching-region' && nextCategory === 'transit-route' ? state.stationZoneMiles : tentacleMiles }); }}>{categoryChoices.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
                    {solo && constraint.kind === 'photo-reference' && category === 'cardinal-view' && <label className="wide">Direction<select value={constraint.direction} disabled={!!askedRecord} onChange={(event) => patchConstraint(constraint.id, { direction: event.target.value as Constraint['direction'] })}>{['north', 'east', 'south', 'west'].map((direction) => <option key={direction}>{direction}</option>)}</select></label>}
                    {constraint.kind === 'matching-region' && category === 'transit-route' && <label className="wide">Seeker’s transit service<select value={constraint.regionId ?? ''} disabled={!!askedRecord} onChange={(event) => patchConstraint(constraint.id, { regionId: event.target.value })}>{scopedRoutes.map((route) => <option key={route.id} value={route.id}>{transitRouteLabel(route)}</option>)}</select></label>}
                    {!solo && constraint.kind === 'tentacle' && constraint.answer === 'yes' && <label className="wide">Named {category === 'transit-route' ? 'route' : 'POI'}<select value={constraint.regionId ?? ''} onChange={(event) => patchConstraint(constraint.id, { regionId: event.target.value })}><option value="">Choose the hider’s answer</option>{category === 'transit-route' ? primaryTransitRoutes.filter((route) => distanceToRoute(constraint.origin, route) <= (constraint.distanceMiles ?? 1)).map((route) => <option key={route.id} value={route.id}>{route.id} line</option>) : tentacleChoices.map((poi) => <option key={poi.id} value={poi.id}>{poi.name}</option>)}</select></label>}
                  </div>
                  {constraint.kind === 'matching-region' && category !== 'transit-route' && <p className="derived">Seeker’s match: <b>{matchingSource ?? 'set the seeker pin'}</b></p>}
                  {usesOrigin && !askedRecord && <MapLinkField label={constraint.kind === 'thermometer' ? 'Starting pin' : 'Seeker pin'} value={constraint.originMapUrl ?? ''} onChange={(originMapUrl) => patchConstraint(constraint.id, { originMapUrl })} onResolved={(origin) => applyConstraintPosition(constraint, { origin }, origin)} onMessage={setMessage} />}
                  {usesTarget && !askedRecord && <MapLinkField label={constraint.kind === 'thermometer' ? 'Ending pin' : 'Comparison pin'} value={constraint.targetMapUrl ?? ''} onChange={(targetMapUrl) => patchConstraint(constraint.id, { targetMapUrl })} onResolved={(target) => applyConstraintPosition(constraint, { target }, target)} onMessage={setMessage} />}
                  {solo && !askedRecord && <button type="button" className="full keep" disabled={soloBusy || !!solo.reveal} onClick={() => void askSolo(constraint)}>{soloBusy ? 'AI is answering…' : 'Ask AI'}</button>}
                  <details className="rule-notes"><summary>Rulebook notes</summary>{selectedSubject && <p className="support-line"><b>{selectedSubject.support === 'approximate' ? 'Approximate map support' : selectedSubject.support === 'reference' ? 'Reference card' : 'Mapped exactly'}</b></p>}<ul>{orderedRuleNotes(constraint.kind, questionNotes, selectedSubject?.notes).map((note) => <li key={note}>{note}</li>)}</ul>{(definition.drawInstruction || definition.timeLimit) && <p>{definition.drawInstruction && <span><b>Hider cards after answering:</b> {definition.drawInstruction}</span>}{definition.timeLimit && <span><b>Answer time:</b> {definition.timeLimit}</span>}</p>}{definition.sourceUrl && <a href={definition.sourceUrl} target="_blank" rel="noreferrer">Open rulebook page</a>}</details>
                  {!askedRecord && <button className="danger remove" onClick={() => setState((current) => ({ ...current, constraints: current.constraints.filter((candidate) => candidate.id !== constraint.id) }))}>Remove question</button>}
                </article>
              );
            })}
          </section>

          <details className="panel legend-panel">
            <summary>Legend, data, and coverage</summary>
            <div className="legend-key"><span className="rail" />Light rail <span className="rapid" />Rapid Muni <span className="other-transit" />Other transit <span className="eligible" />Eligible station <span className="cut" />Cut station/route</div>
            <p className="source">{provenance.totalPois.toLocaleString()} normalized POIs from <a href={provenance.sourceUrl}>the SF spreadsheet</a> · retrieved {provenance.retrieved}</p>
            <p className="source">Routes: <a href={transitProvenance.sourceUrl}>DataSF Muni Simple Routes</a> · coastline: <a href={coastlineProvenance.sourceUrl}>DataSF SF Shoreline and Islands</a>.</p>
            <p className="source">Districts/water: <a href={rulebookAreaProvenance.districts.sourceUrl}>DataSF districts</a> / <a href={rulebookAreaProvenance.water.sourceUrl}>water bodies</a> · streets: <a href={streetProvenance.sourceUrl}>DataSF centerlines</a> · elevation: <a href={elevationProvenance.sourceUrl}>Mapzen terrain tiles</a>.</p>
            <p className="source">ZIP areas: <a href={rulebookAreaProvenance.zipCodes.sourceUrl}>DataSF San Francisco ZIP Codes</a> · {zipCodeAreas.features.length} merged regions.</p>
            <p className="source">Interactive map coverage includes all in-play SF matching and measuring subjects. Approximate cards are labeled in their question notes. Photo cards are retained as reference because they do not determine a polygon. The map does not certify a final hiding spot: players must still confirm it is publicly accessible during game hours, safe, and within 10 feet of a marked path/road that the map app will use for walking directions.</p>
            {([['Matching', MATCHING_SUBJECTS], ['Measuring', MEASURING_SUBJECTS], ['Photos', PHOTO_SUBJECTS]] as const).map(([group, subjects]) => <details className="coverage-group" key={group}><summary>{group} deck audit · {subjects.filter((subject) => subject.status === 'in-play').length} in play</summary>{subjects.map((subject) => <p key={subject.id}><b>{subject.label}</b> · {subject.status === 'out-of-play' ? 'out of SF deck' : subject.support}</p>)}</details>)}
            {state.layers['supervisor-districts'] && supervisorDistricts.features.map((feature, index) => <div className="legend" key={feature.properties.id}><i style={{ background: partitionColor(index, supervisorDistricts.features.length, 15) }} /><span>{feature.properties.name}</span><small>DataSF</small></div>)}
            {state.layers['zip-codes'] && zipCodeAreas.features.map((feature, index) => <div className="legend" key={feature.properties.id}><i style={{ background: partitionColor(index, zipCodeAreas.features.length, 210) }} /><span>{feature.properties.name}</span><small>ZIP</small></div>)}
            {state.layers.landmasses && sfLandmasses.features.map((feature, index) => <div className="legend" key={feature.properties.id}><i style={{ background: partitionColor(index, sfLandmasses.features.length, 35) }} /><span>{feature.properties.name}</span><small>SF rule</small></div>)}
          </details>
        </aside>
        <section className={`map-wrap${traceScreenshot ? ' trace-screenshot' : ''}`} aria-label={traceScreenshot ? 'Trace-only screenshot view' : 'San Francisco feasible area map'}>
          {status !== 'ready' && <div className={`notice ${status}`} role="status">{status === 'loading' ? 'Loading map…' : message}</div>}
          <div ref={mapNode} className="map" />
          {traceScreenshot && <button type="button" className="trace-screenshot-exit" onClick={toggleTraceScreenshot} aria-label="Exit trace screenshot view" title="Show map again">×</button>}
          {state.mode === 'hider' && traceActive && <div className="trace-map-controls" role="toolbar" aria-label="Active path tracing controls"><span>{tracePoints.length} points · {traceDistanceMiles < 0.1 ? `${Math.round(traceDistanceMiles * 5280)} ft` : `${traceDistanceMiles.toFixed(2)} mi`}</span><button type="button" className="secondary" disabled={tracePoints.length === 0} onClick={() => setTracePoints((current) => current.slice(0, -1))}>Undo</button><button type="button" className="danger" onClick={() => setTraceActive(false)}>Finish</button></div>}
          <div className="attribution">POIs: linked SF dataset · routes/coast: DataSF · basemap © Google</div>
        </section>
      </div>
      {soloSetupOpen && <div className="modal-backdrop" role="presentation">
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="solo-setup-title">
          <h2 id="solo-setup-title">Start Solo game</h2>
          <p className="helper">The AI will use walking and public transit to choose a committed hiding station reachable within 30 minutes. Seeking begins immediately after the route is simulated.</p>
          <MapLinkField
            label="Starting location"
            value={soloStartMapUrl}
            onChange={setSoloStartMapUrl}
            onResolved={(position) => { setSoloStartPosition(position); mapRef.current?.panTo(position); }}
            onMessage={setMessage}
          />
          {soloStartPosition && <p className="success-line">Starting location ready</p>}
          <label className="stacked solo-datetime">Date and time · San Francisco<input type="datetime-local" value={soloDateTime} onChange={(event) => setSoloDateTime(event.target.value)} /></label>
          <p className="helper">Google transit schedules support 7 days in the past through 100 days ahead.</p>
          <div className="two-buttons modal-actions">
            <button type="button" className="secondary" disabled={soloBusy} onClick={() => setSoloSetupOpen(false)}>Cancel</button>
            <button type="button" className="keep" disabled={soloBusy || !soloStartPosition} onClick={() => void startSolo()}>{soloBusy ? 'Finding a hiding spot…' : 'Start seeking'}</button>
          </div>
        </section>
      </div>}
      {message && status === 'ready' && <button className="toast" role="status" onClick={() => setMessage('')} aria-label="Dismiss message">{message}</button>}
    </main>
  );
}
