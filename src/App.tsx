import { useEffect, useMemo, useRef, useState } from 'react';
import * as turf from '@turf/turf';
import { combineConstraints, nearestPoi, partition, stationIdsOverlappingArea } from './geometry';
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
import { googleMapsLinkForPosition, resolveGoogleMapsLink } from './mapLinks';
import { PRIMARY_QUESTION_KINDS, QUESTION_DEFINITIONS } from './questions';
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
  coastline,
  coastlineProvenance,
  distanceToRoute,
  eligibleStationIds,
  routesForStation,
  transitProvenance,
  transitRouteGeoJson,
  transitRoutes,
  validStations,
} from './transit';
import type { Constraint, Eligibility, Position, QuestionKind, SharedState } from './types';
import { pathDistanceMiles, pathGeoJson } from './trace';
import './style.css';

const VISIBLE_POI_PARTITIONS: PoiCategory[] = [...PARTITION_CATEGORIES, 'rail-station', 'aquarium'];
const REGION_CATEGORIES: PoiCategory[] = [
  ...PARTITION_CATEGORIES,
  'game-valid-station',
  'rail-station',
  'aquarium',
];
const initialLayers = {
  ...Object.fromEntries(VISIBLE_POI_PARTITIONS.map((category) => [category, category === 'museum'])),
  'station-zones': true,
  'transit-routes': true,
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
  stationStatuses: {},
  routeStatuses: {},
};
const colors = ['#553c9a', '#007c78', '#b45309', '#be185d', '#166534', '#0369a1', '#9f1239'];
const partitionColor = (index: number, total: number, offset = 0) =>
  `hsl(${Math.round((index * 360) / Math.max(1, total) + offset) % 360}, 62%, 39%)`;
const measuringChoices = selectableSubjects(MEASURING_SUBJECTS);
const matchingChoices = selectableSubjects(MATCHING_SUBJECTS);
const photoChoices = selectableSubjects(PHOTO_SUBJECTS);

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
    return payload ? decodeState(payload) : initial;
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
      <label>
        {label}
        <input
          type="url"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          placeholder="Paste a Google Maps link"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <div className="map-link-actions">
        <button className="secondary" type="button" disabled={!value.trim() || !!busy} onClick={apply}>
          {busy === 'link' ? 'Reading…' : 'Use pin'}
        </button>
        <button className="secondary" type="button" disabled={!!busy} onClick={useCurrentLocation}>
          {busy === 'location' ? 'Locating…' : 'Use current location'}
        </button>
        <button className="secondary clear-link" type="button" disabled={!value || !!busy} onClick={clear} aria-label={`Clear ${label} link`}>Clear</button>
      </div>
    </div>
  );
}

function answerOptions(kind: QuestionKind) {
  if (kind === 'thermometer') return ['warmer', 'colder'];
  if (kind === 'measuring' || kind === 'coastline') return ['closer', 'farther'];
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
  const [state, setState] = useState<SharedState>(restoredState);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const [selectedStation, setSelectedStation] = useState(validStations[0]?.id ?? '');
  const [traceActive, setTraceActive] = useState(false);
  const [tracePoints, setTracePoints] = useState<Position[]>([]);

  const partitions = useMemo(
    () => Object.fromEntries(REGION_CATEGORIES.map((category) => [category, partition(category)])),
    [],
  ) as Record<PoiCategory, ReturnType<typeof partition>>;
  const regions = useMemo(() => Object.assign({}, ...Object.values(partitions)), [partitions]);
  const statusEligibleIds = useMemo(
    () => eligibleStationIds(state.stationStatuses, state.routeStatuses),
    [state.routeStatuses, state.stationStatuses],
  );
  const feasible = useMemo(
    () => combineConstraints(state.constraints, regions),
    [regions, state.constraints],
  );
  const eligibleIds = useMemo(
    () => stationIdsOverlappingArea(statusEligibleIds, state.stationZoneMiles, feasible),
    [feasible, state.stationZoneMiles, statusEligibleIds],
  );
  const traceDistanceMiles = useMemo(
    () => pathDistanceMiles(tracePoints),
    [tracePoints],
  );

  useEffect(() => {
    const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
    if (!key) {
      setStatus('error');
      setMessage('Add VITE_GOOGLE_MAPS_API_KEY to .env to load the map.');
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
    drawn.current?.setMap(null);
    const data = new google.maps.Data({ map });
    drawn.current = data;

    VISIBLE_POI_PARTITIONS.filter((category) => state.layers[category]).forEach((category) => {
      Object.entries(partitions[category]).forEach(([id, feature], index) => {
        data.addGeoJson({ ...feature, properties: { kind: 'region', color: colors[index % colors.length], id } });
      });
    });
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
    if (state.layers['transit-routes']) {
      transitRouteGeoJson.features.forEach((feature) => {
        const routeStatus = state.routeStatuses[feature.properties.routeId];
        data.addGeoJson({ ...feature, properties: { ...feature.properties, kind: 'transit-route', status: routeStatus ?? '' } });
      });
    }
    validStations.forEach((station) => {
      const eligible = eligibleIds.includes(station.id);
      const stationStatus = state.stationStatuses[station.id];
      data.addGeoJson({
        type: 'Feature',
        properties: { kind: 'station', id: station.id, status: stationStatus ?? '', eligible },
        geometry: { type: 'Point', coordinates: [station.lng, station.lat] },
      });
      if (state.layers['station-zones']) {
        data.addGeoJson({
          ...turf.circle([station.lng, station.lat], state.stationZoneMiles, { units: 'miles', steps: 24 }),
          properties: { kind: 'station-zone', id: station.id, status: stationStatus ?? '', eligible },
        });
      }
    });
    data.addGeoJson({ ...feasible, properties: { kind: 'feasible' } });
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
      const statusValue = feature.getProperty('status');
      const eligibilityValue = feature.getProperty('eligible');
      const routeStatus = statusValue === 'in' || statusValue === 'out' ? statusValue : undefined;
      const eligible = eligibilityValue !== false;
      if (kind === 'feasible') return { fillColor: '#16a34a', fillOpacity: 0.28, strokeColor: '#166534', strokeWeight: 3 };
      if (kind === 'coastline') return { strokeColor: '#0284c7', strokeWeight: 4, fillOpacity: 0 };
      if (kind === 'hider-trace') return { strokeColor: '#e11d48', strokeOpacity: 0.95, strokeWeight: 5, zIndex: 20 };
      if (kind === 'trace-point') {
        const endpoint = feature.getProperty('endpoint');
        return { icon: { path: google.maps.SymbolPath.CIRCLE, fillColor: endpoint ? '#e11d48' : '#ffffff', fillOpacity: 1, strokeColor: '#e11d48', strokeWeight: 2, scale: endpoint ? 5 : 3 }, zIndex: 21 };
      }
      if (kind === 'transit-route') {
        const mode = feature.getProperty('mode');
        return {
          strokeColor: routeStatus === 'out' ? '#b91c1c' : routeStatus === 'in' ? '#15803d' : mode === 'light-rail' ? '#7c3aed' : '#ea580c',
          strokeOpacity: routeStatus === 'out' ? 0.48 : 0.82,
          strokeWeight: routeStatus ? 6 : 4,
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
      const colorValue = feature.getProperty('color');
      const regionColor = typeof colorValue === 'string' ? colorValue : '#553c9a';
      return { fillColor: regionColor, fillOpacity: kind === 'geographic-region' ? 0.07 : 0.12, strokeColor: regionColor, strokeWeight: kind === 'geographic-region' ? 2 : 1 };
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
  }, [eligibleIds, feasible, partitions, state.hiderPosition, state.layers, state.mode, state.routeStatuses, state.stationStatuses, state.stationZoneMiles, status, traceActive, tracePoints]);

  const patchConstraint = (id: string, update: Partial<Constraint>) =>
    setState((current) => ({
      ...current,
      constraints: current.constraints.map((constraint) =>
        constraint.id === id ? { ...constraint, ...update } : constraint,
      ),
    }));

  const add = () => {
    const kind = (document.querySelector('#kind') as HTMLSelectElement).value as QuestionKind;
    const category = defaultCategory(kind);
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
    setTraceActive(true);
    requestAnimationFrame(() => mapNode.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  };

  const share = async () => {
    const url = new URL(location.href);
    const shareState = { ...state, hiderPosition: undefined, hiderMapUrl: undefined };
    url.searchParams.set('config', encodeState(shareState));
    history.replaceState({}, '', url);
    try {
      await navigator.clipboard?.writeText(url.href);
      setMessage('Share URL copied. Your hider position was not included.');
    } catch {
      setMessage('Share URL is ready in the address bar. Your hider position was not included.');
    }
  };

  return (
    <main>
      <header>
        <div>
          <h1>SF Hiding Area</h1>
          <p>Rulebook-aware mapping for seekers and hiders.</p>
        </div>
        <button onClick={share} aria-label="Copy shareable configuration URL">Share</button>
      </header>
      <nav className="mode-switch" aria-label="Player mode">
        <button className={state.mode === 'seeker' ? 'active' : ''} onClick={() => setState((current) => ({ ...current, mode: 'seeker' }))}>Seeker</button>
        <button className={state.mode === 'hider' ? 'active' : ''} onClick={() => setState((current) => ({ ...current, mode: 'hider' }))}>Hider answer helper</button>
      </nav>
      <div className="layout">
        <aside aria-label="Question constraint controls">
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
                <p className="helper">For “Trace nearest street/path,” start tracing and tap each bend on the map from intersection to intersection. Undo points as needed, then take a screenshot. Trace data stays on this device and is omitted from shared URLs.</p>
                <p className="trace-stats"><b>{tracePoints.length}</b> points · <b>{traceDistanceMiles < 0.1 ? `${Math.round(traceDistanceMiles * 5280)} ft` : `${traceDistanceMiles.toFixed(2)} mi`}</b></p>
                <div className="trace-buttons">
                  <button type="button" className={traceActive ? 'danger' : 'keep'} onClick={toggleTrace}>{traceActive ? 'Finish tracing' : 'Start tracing'}</button>
                  <button type="button" className="secondary" disabled={tracePoints.length === 0} onClick={() => setTracePoints((current) => current.slice(0, -1))}>Undo point</button>
                  <button type="button" className="secondary" disabled={!state.hiderPosition} onClick={addHiderPositionToTrace}>Add my pin</button>
                  <button type="button" className="secondary" disabled={tracePoints.length === 0} onClick={fitTrace}>Fit trace</button>
                  <button type="button" className="danger" disabled={tracePoints.length === 0} onClick={() => { setTracePoints([]); setTraceActive(false); }}>Clear</button>
                </div>
                {traceActive && <p className="success-line">Tracing is active · tap the map to add the next point</p>}
              </div>
            </section>
          )}

          <details className="panel" open>
            <summary>Transit and map layers</summary>
            <div className="toggle-grid">
              <label className="toggle"><input type="checkbox" checked={!!state.layers['station-zones']} onChange={(event) => setState((current) => ({ ...current, layers: { ...current.layers, 'station-zones': event.target.checked } }))} />Hiding-zone radii</label>
              <label className="toggle"><input type="checkbox" checked={!!state.layers['transit-routes']} onChange={(event) => setState((current) => ({ ...current, layers: { ...current.layers, 'transit-routes': event.target.checked } }))} />Light rail + Rapid Muni</label>
              <label className="toggle"><input type="checkbox" checked={!!state.layers.coastline} onChange={(event) => setState((current) => ({ ...current, layers: { ...current.layers, coastline: event.target.checked } }))} />Coastline</label>
            </div>
            <div className="inline-controls">
              <label>Hiding-zone radius (miles)<input type="number" min="0.05" max="5" step="0.05" value={state.stationZoneMiles} onChange={(event) => setState((current) => ({ ...current, stationZoneMiles: Math.max(0.05, Number(event.target.value) || 0.25) }))} /></label>
            </div>
            <p className="helper">{eligibleIds.length} of {validStations.length} valid stations currently possible. A station turns off when its hiding-radius zone no longer overlaps the green feasible area; explicit station and route cuts also apply.</p>
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
            <label className="stacked">Valid station<select value={selectedStation} onChange={(event) => setSelectedStation(event.target.value)}>{validStations.map((station) => <option key={station.id} value={station.id}>{station.name}</option>)}</select></label>
            {selectedStation && <p className="helper">Lines nearby: {routesForStation(selectedStation).join(', ') || 'no Rapid/light-rail line match'}</p>}
            <div className="three-buttons">
              <button type="button" className="keep" onClick={() => setEligibility('station', selectedStation, 'in')}>Keep in</button>
              <button type="button" className="danger" onClick={() => setEligibility('station', selectedStation, 'out')}>Cut out</button>
              <button type="button" className="secondary" onClick={() => setEligibility('station', selectedStation, '')}>Clear</button>
            </div>
            <h3>Cut or keep an entire route</h3>
            <div className="route-list">
              {transitRoutes.map((route) => (
                <label key={route.id}><span><b>{route.id}</b><small>{route.mode === 'light-rail' ? 'light rail' : 'Rapid Muni'}</small></span><select aria-label={`${route.id} route eligibility`} value={state.routeStatuses[route.id] ?? ''} onChange={(event) => setEligibility('route', route.id, event.target.value as Eligibility | '')}><option value="">Unmarked</option><option value="in">Keep in</option><option value="out">Cut out</option></select></label>
              ))}
            </div>
          </details>

          <details className="panel">
            <summary>POI partition layers</summary>
            <div className="toggle-grid">
              {VISIBLE_POI_PARTITIONS.map((category) => (
                <label className="toggle" key={category}><input type="checkbox" checked={!!state.layers[category]} onChange={(event) => setState((current) => ({ ...current, layers: { ...current.layers, [category]: event.target.checked } }))} />{CATEGORY_LABELS[category]}</label>
              ))}
            </div>
          </details>

          <section className="questions">
            <div className="section-heading"><h2>Questions</h2></div>
            <div className="add"><select id="kind" aria-label="Question type">{PRIMARY_QUESTION_KINDS.map((kind) => <option key={kind} value={kind}>{QUESTION_DEFINITIONS[kind].label}</option>)}</select><button onClick={add}>Add</button></div>
            {state.constraints.length === 0 && <p className="empty-state">Add a question, then paste the Google Maps links the players shared.</p>}
            {state.constraints.map((constraint) => {
              const definition = QUESTION_DEFINITIONS[constraint.kind];
              const usesOrigin = constraint.kind !== 'photo-reference' && !(constraint.kind === 'matching-region' && constraint.category === 'transit-route');
              const usesTarget = ['thermometer', 'closer', 'farther'].includes(constraint.kind);
              const usesDistance = ['radar', 'thermometer', 'radius', 'tentacle', 'closer', 'farther', 'intersection', 'exclusion'].includes(constraint.kind) || (constraint.kind === 'matching-region' && constraint.category === 'transit-route');
              const usesCategory = ['matching-region', 'measuring', 'tentacle', 'photo-reference'].includes(constraint.kind);
              const category = constraint.category;
              const categoryChoices = subjectChoices(constraint.kind);
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
                  <div className="constraint-heading"><input aria-label="Constraint name" value={constraint.name} onChange={(event) => patchConstraint(constraint.id, { name: event.target.value })} /><label className="enabled"><input type="checkbox" checked={constraint.enabled} onChange={(event) => patchConstraint(constraint.id, { enabled: event.target.checked })} />Enabled</label></div>
                  <p className="question-help">{definition.help}</p>
                  {state.mode === 'hider' && <div className={`answer-result ${state.hiderPosition ? '' : 'waiting'}`}><span>Hider answer</span><strong>{state.hiderPosition ? hiderAnswer(constraint, state.hiderPosition, regions) : 'Set your position above'}</strong></div>}
                  <div className="control-grid">
                    {constraint.kind !== 'photo-reference' && <label>Recorded answer<select aria-label={`${constraint.name} answer`} value={constraint.answer} onChange={(event) => patchConstraint(constraint.id, { answer: event.target.value as Constraint['answer'] })}>{answerOptions(constraint.kind).map((answer) => <option key={answer} value={answer}>{answer === 'yes' && constraint.kind === 'tentacle' ? 'named POI' : answer}</option>)}</select></label>}
                    {usesDistance && <label>Miles<input aria-label={`${constraint.name} distance in miles`} type="number" min="0.05" step="0.05" value={constraint.distanceMiles} onChange={(event) => patchConstraint(constraint.id, { distanceMiles: Number(event.target.value) })} /></label>}
                    {constraint.kind === 'direction' && <label>Direction<select value={constraint.direction} onChange={(event) => patchConstraint(constraint.id, { direction: event.target.value as Constraint['direction'] })}>{['north', 'south', 'east', 'west'].map((direction) => <option key={direction}>{direction}</option>)}</select></label>}
                    {usesCategory && <label className="wide">Subject<select value={category} onChange={(event) => { const nextCategory = event.target.value; const tentacleMiles = constraint.kind === 'tentacle' ? (nextCategory === 'transit-route' || nextCategory === 'aquarium' ? 15 : 1) : constraint.distanceMiles; patchConstraint(constraint.id, { category: nextCategory, regionId: nextCategory === 'transit-route' ? transitRoutes[0]?.id : nearestPoi(nextCategory, constraint.origin)?.id, distanceMiles: constraint.kind === 'matching-region' && nextCategory === 'transit-route' ? state.stationZoneMiles : tentacleMiles }); }}>{categoryChoices.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
                    {constraint.kind === 'matching-region' && category === 'transit-route' && <label className="wide">Seeker’s transit service<select value={constraint.regionId ?? ''} onChange={(event) => patchConstraint(constraint.id, { regionId: event.target.value })}>{transitRoutes.map((route) => <option key={route.id} value={route.id}>{route.id} — {route.mode === 'light-rail' ? 'light rail' : 'Rapid Muni'}</option>)}</select></label>}
                    {constraint.kind === 'tentacle' && constraint.answer === 'yes' && <label className="wide">Named {category === 'transit-route' ? 'route' : 'POI'}<select value={constraint.regionId ?? ''} onChange={(event) => patchConstraint(constraint.id, { regionId: event.target.value })}><option value="">Choose the hider’s answer</option>{category === 'transit-route' ? transitRoutes.filter((route) => distanceToRoute(constraint.origin, route) <= (constraint.distanceMiles ?? 1)).map((route) => <option key={route.id} value={route.id}>{route.id} line</option>) : tentacleChoices.map((poi) => <option key={poi.id} value={poi.id}>{poi.name}</option>)}</select></label>}
                  </div>
                  {constraint.kind === 'matching-region' && category !== 'transit-route' && <p className="derived">Seeker’s match: <b>{matchingSource ?? 'set the seeker pin'}</b></p>}
                  {usesOrigin && <MapLinkField label={constraint.kind === 'thermometer' ? 'Starting pin' : 'Seeker pin'} value={constraint.originMapUrl ?? ''} onChange={(originMapUrl) => patchConstraint(constraint.id, { originMapUrl })} onResolved={(origin) => applyConstraintPosition(constraint, { origin }, origin)} onMessage={setMessage} />}
                  {usesTarget && <MapLinkField label={constraint.kind === 'thermometer' ? 'Ending pin' : 'Comparison pin'} value={constraint.targetMapUrl ?? ''} onChange={(targetMapUrl) => patchConstraint(constraint.id, { targetMapUrl })} onResolved={(target) => applyConstraintPosition(constraint, { target }, target)} onMessage={setMessage} />}
                  <div className="rule-notes"><h3>Rulebook notes</h3>{selectedSubject && <p className="support-line"><b>{selectedSubject.support === 'approximate' ? 'Approximate map support' : selectedSubject.support === 'reference' ? 'Reference card' : 'Mapped exactly'}</b></p>}<ul>{[...definition.notes, ...(selectedSubject?.notes ?? [])].map((note) => <li key={note}>{note}</li>)}</ul>{(definition.drawInstruction || definition.timeLimit) && <p>{definition.drawInstruction && <span><b>Hider cards after answering:</b> {definition.drawInstruction}</span>}{definition.timeLimit && <span><b>Answer time:</b> {definition.timeLimit}</span>}</p>}{definition.sourceUrl && <a href={definition.sourceUrl} target="_blank" rel="noreferrer">Open rulebook page</a>}</div>
                  <button className="danger remove" onClick={() => setState((current) => ({ ...current, constraints: current.constraints.filter((candidate) => candidate.id !== constraint.id) }))}>Remove question</button>
                </article>
              );
            })}
          </section>

          <details className="panel legend-panel">
            <summary>Legend, data, and coverage</summary>
            <div className="legend-key"><span className="rail" />Light rail <span className="rapid" />Rapid Muni <span className="eligible" />Eligible station <span className="cut" />Cut station/route</div>
            <p className="source">{provenance.totalPois.toLocaleString()} normalized POIs from <a href={provenance.sourceUrl}>the SF spreadsheet</a> · retrieved {provenance.retrieved}</p>
            <p className="source">Routes: <a href={transitProvenance.sourceUrl}>DataSF Muni Simple Routes</a> · coastline: <a href={coastlineProvenance.sourceUrl}>DataSF SF Shoreline and Islands</a>.</p>
            <p className="source">Districts/water: <a href={rulebookAreaProvenance.districts.sourceUrl}>DataSF districts</a> / <a href={rulebookAreaProvenance.water.sourceUrl}>water bodies</a> · streets: <a href={streetProvenance.sourceUrl}>DataSF centerlines</a> · elevation: <a href={elevationProvenance.sourceUrl}>Mapzen terrain tiles</a>.</p>
            <p className="source">ZIP areas: <a href={rulebookAreaProvenance.zipCodes.sourceUrl}>DataSF San Francisco ZIP Codes</a> · {zipCodeAreas.features.length} merged regions.</p>
            <p className="source">Interactive map coverage includes all in-play SF matching and measuring subjects. Approximate cards are labeled in their question notes. Photo cards are retained as reference because they do not determine a polygon. The map does not certify a final hiding spot: players must still confirm it is publicly accessible during game hours, safe, and within 10 feet of a marked path/road that the map app will use for walking directions.</p>
            {([['Matching', MATCHING_SUBJECTS], ['Measuring', MEASURING_SUBJECTS], ['Photos', PHOTO_SUBJECTS]] as const).map(([group, subjects]) => <details className="coverage-group" key={group}><summary>{group} deck audit · {subjects.filter((subject) => subject.status === 'in-play').length} in play</summary>{subjects.map((subject) => <p key={subject.id}><b>{subject.label}</b> · {subject.status === 'out-of-play' ? 'out of SF deck' : subject.support}</p>)}</details>)}
            {state.layers['supervisor-districts'] && supervisorDistricts.features.map((feature, index) => <div className="legend" key={feature.properties.id}><i style={{ background: partitionColor(index, supervisorDistricts.features.length, 15) }} /><span>{feature.properties.name}</span><small>DataSF</small></div>)}
            {state.layers['zip-codes'] && zipCodeAreas.features.map((feature, index) => <div className="legend" key={feature.properties.id}><i style={{ background: partitionColor(index, zipCodeAreas.features.length, 210) }} /><span>{feature.properties.name}</span><small>ZIP</small></div>)}
            {state.layers.landmasses && sfLandmasses.features.map((feature, index) => <div className="legend" key={feature.properties.id}><i style={{ background: partitionColor(index, sfLandmasses.features.length, 35) }} /><span>{feature.properties.name}</span><small>SF rule</small></div>)}
            {VISIBLE_POI_PARTITIONS.filter((category) => state.layers[category]).flatMap((category) => pois.filter((poi) => poi.category === category).map((poi, index) => <div className="legend" key={poi.id}><i style={{ background: colors[index % colors.length] }} /><a href={poi.sourceMapUrl ?? googleMapsLinkForPosition(poi)} target="_blank" rel="noreferrer">{poi.name}</a><small>row {poi.sourceRow}</small></div>))}
          </details>
        </aside>
        <section className="map-wrap" aria-label="San Francisco feasible area map">
          {status !== 'ready' && <div className={`notice ${status}`} role="status">{status === 'loading' ? 'Loading map…' : message}</div>}
          <div ref={mapNode} className="map" />
          {state.mode === 'hider' && traceActive && <div className="trace-map-controls" role="toolbar" aria-label="Active path tracing controls"><span>{tracePoints.length} points · {traceDistanceMiles < 0.1 ? `${Math.round(traceDistanceMiles * 5280)} ft` : `${traceDistanceMiles.toFixed(2)} mi`}</span><button type="button" className="secondary" disabled={tracePoints.length === 0} onClick={() => setTracePoints((current) => current.slice(0, -1))}>Undo</button><button type="button" className="danger" onClick={() => setTraceActive(false)}>Finish</button></div>}
          <div className="attribution">POIs: linked SF dataset · routes/coast: DataSF · basemap © Google</div>
        </section>
      </div>
      {message && status === 'ready' && <button className="toast" role="status" onClick={() => setMessage('')} aria-label="Dismiss message">{message}</button>}
    </main>
  );
}
