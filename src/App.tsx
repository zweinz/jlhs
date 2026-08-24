import { useEffect, useMemo, useRef, useState } from 'react';
import { combineConstraints, partition } from './geometry';
import {
  CATEGORY_LABELS,
  PARTITION_CATEGORIES,
  pois,
  provenance,
  SF_BOUNDS,
  type PartitionCategory,
} from './data';
import { QUESTION_DEFINITIONS } from './questions';
import { decodeState, encodeState } from './share';
import type { Constraint, QuestionKind, SharedState } from './types';
import './style.css';

const initialLayers = Object.fromEntries(PARTITION_CATEGORIES.map((category) => [category, category === 'museum']));
const initial: SharedState = {
  version: 1,
  constraints: [],
  layers: initialLayers,
  viewport: { center: { lat: 37.77, lng: -122.44 }, zoom: 12 },
};
const colors = ['#553c9a', '#007c78', '#b45309', '#be185d', '#166534', '#0369a1', '#9f1239'];

function restoredState() {
  try {
    const payload = new URLSearchParams(location.search).get('config');
    return payload ? decodeState(payload) : initial;
  } catch {
    return initial;
  }
}

export default function App() {
  const mapNode = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const drawn = useRef<google.maps.Data | null>(null);
  const [state, setState] = useState<SharedState>(restoredState);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState('');

  const partitions = useMemo(
    () => Object.fromEntries(PARTITION_CATEGORIES.map((category) => [category, partition(category)])),
    [],
  ) as Record<PartitionCategory, ReturnType<typeof partition>>;
  const regions = useMemo(() => Object.assign({}, ...Object.values(partitions)), [partitions]);
  const feasible = useMemo(() => combineConstraints(state.constraints, regions), [state.constraints, regions]);

  useEffect(() => {
    const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
    if (!key) {
      setStatus('error');
      setMessage('Add VITE_GOOGLE_MAPS_API_KEY to .env to load the map.');
      return;
    }
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly`;
    script.async = true;
    script.onload = () => {
      if (!mapNode.current) return;
      const map = new google.maps.Map(mapNode.current, {
        center: state.viewport.center,
        zoom: state.viewport.zoom,
        restriction: { latLngBounds: SF_BOUNDS, strictBounds: false },
        mapTypeControl: false,
      });
      mapRef.current = map;
      setStatus('ready');
      map.addListener('idle', () => {
        const center = map.getCenter();
        if (center) {
          setState((current) => ({
            ...current,
            viewport: { center: { lat: center.lat(), lng: center.lng() }, zoom: map.getZoom() ?? 12 },
          }));
        }
      });
    };
    script.onerror = () => {
      setStatus('error');
      setMessage('Google Maps could not load. Check the API key, referrer restrictions, and network connection.');
    };
    document.head.append(script);
    return () => script.remove();
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== 'ready') return;
    drawn.current?.setMap(null);
    const data = new google.maps.Data({ map });
    drawn.current = data;
    PARTITION_CATEGORIES.filter((category) => state.layers[category]).forEach((category) => {
      Object.entries(partitions[category]).forEach(([id, feature], index) => {
        data.addGeoJson({ ...feature, properties: { kind: 'region', color: colors[index % colors.length], id } });
      });
    });
    data.addGeoJson({ ...feasible, properties: { kind: 'feasible' } });
    data.setStyle((feature) => {
      const color = feature.getProperty('color');
      const regionColor = typeof color === 'string' ? color : '#553c9a';
      return feature.getProperty('kind') === 'feasible'
        ? { fillColor: '#16a34a', fillOpacity: 0.28, strokeColor: '#166534', strokeWeight: 3 }
        : { fillColor: regionColor, fillOpacity: 0.12, strokeColor: regionColor, strokeWeight: 1 };
    });
  }, [feasible, partitions, state.layers, status]);

  const add = () => {
    const kind = (document.querySelector('#kind') as HTMLSelectElement).value as QuestionKind;
    const regionId = Object.keys(partitions.museum)[0];
    setState((current) => ({
      ...current,
      constraints: [
        ...current.constraints,
        {
          id: crypto.randomUUID(),
          name: QUESTION_DEFINITIONS[kind].label,
          kind,
          enabled: true,
          answer: kind === 'thermometer' ? 'colder' : 'yes',
          origin: current.viewport.center,
          target: { lat: 37.7857, lng: -122.4011 },
          distanceMiles: kind === 'thermometer' ? 5 : 1,
          direction: 'north',
          regionId,
        },
      ],
    }));
  };
  const patch = (id: string, update: Partial<Constraint>) =>
    setState((current) => ({
      ...current,
      constraints: current.constraints.map((constraint) =>
        constraint.id === id ? { ...constraint, ...update } : constraint,
      ),
    }));
  const share = async () => {
    const url = new URL(location.href);
    url.searchParams.set('config', encodeState(state));
    history.replaceState({}, '', url);
    await navigator.clipboard?.writeText(url.href);
    setMessage('Share URL copied and placed in the address bar.');
  };

  return (
    <main>
      <header>
        <div>
          <h1>SF Hiding Area</h1>
          <p>Combine geographic answers without clipping to the coastline.</p>
        </div>
        <button onClick={share} aria-label="Copy shareable configuration URL">
          Share
        </button>
      </header>
      <div className="layout">
        <aside aria-label="Question constraint controls">
          <section>
            <h2>Partition layers</h2>
            {PARTITION_CATEGORIES.map((category) => (
              <label className="toggle" key={category}>
                <input
                  type="checkbox"
                  checked={!!state.layers[category]}
                  onChange={(event) =>
                    setState((current) => ({
                      ...current,
                      layers: { ...current.layers, [category]: event.target.checked },
                    }))
                  }
                />
                {CATEGORY_LABELS[category]}
              </label>
            ))}
          </section>
          <section>
            <h2>Questions</h2>
            <div className="add">
              <select id="kind" aria-label="Question type">
                {Object.entries(QUESTION_DEFINITIONS).map(([kind, definition]) => (
                  <option key={kind} value={kind}>
                    {definition.label}
                  </option>
                ))}
              </select>
              <button onClick={add}>Add</button>
            </div>
            {state.constraints.length === 0 && <p className="muted">Add an answer to narrow the feasible area.</p>}
            {state.constraints.map((constraint) => (
              <article key={constraint.id}>
                <input
                  aria-label="Constraint name"
                  value={constraint.name}
                  onChange={(event) => patch(constraint.id, { name: event.target.value })}
                />
                <label>
                  <input
                    type="checkbox"
                    checked={constraint.enabled}
                    onChange={(event) => patch(constraint.id, { enabled: event.target.checked })}
                  />{' '}
                  Enabled
                </label>
                <label>
                  Answer
                  <select
                    aria-label={`${constraint.name} answer`}
                    value={constraint.answer}
                    onChange={(event) => patch(constraint.id, { answer: event.target.value as Constraint['answer'] })}
                  >
                    {(constraint.kind === 'thermometer' ? ['warmer', 'colder'] : ['yes', 'no']).map((answer) => (
                      <option key={answer}>{answer}</option>
                    ))}
                  </select>
                </label>
                {constraint.kind === 'direction' && (
                  <label>
                    Direction
                    <select
                      value={constraint.direction}
                      onChange={(event) =>
                        patch(constraint.id, { direction: event.target.value as Constraint['direction'] })
                      }
                    >
                      {['north', 'south', 'east', 'west'].map((direction) => (
                        <option key={direction}>{direction}</option>
                      ))}
                    </select>
                  </label>
                )}
                {constraint.kind === 'matching-region' && (
                  <label>
                    Source POI
                    <select
                      value={constraint.regionId}
                      onChange={(event) => patch(constraint.id, { regionId: event.target.value })}
                    >
                      {PARTITION_CATEGORIES.flatMap((category) =>
                        pois
                          .filter((poi) => poi.category === category)
                          .map((poi) => (
                            <option key={poi.id} value={poi.id}>
                              {CATEGORY_LABELS[category]} — {poi.name}
                            </option>
                          )),
                      )}
                    </select>
                  </label>
                )}
                {constraint.kind !== 'direction' && constraint.kind !== 'matching-region' && (
                  <label>
                    Miles
                    <input
                      aria-label={`${constraint.name} distance in miles`}
                      type="number"
                      min="0.1"
                      step="0.1"
                      value={constraint.distanceMiles}
                      onChange={(event) => patch(constraint.id, { distanceMiles: Number(event.target.value) })}
                    />
                  </label>
                )}
                <button
                  className="danger"
                  onClick={() =>
                    setState((current) => ({
                      ...current,
                      constraints: current.constraints.filter((candidate) => candidate.id !== constraint.id),
                    }))
                  }
                >
                  Remove
                </button>
              </article>
            ))}
          </section>
          <section>
            <h2>Legend</h2>
            {PARTITION_CATEGORIES.filter((category) => state.layers[category]).flatMap((category) =>
              pois
                .filter((poi) => poi.category === category)
                .map((poi, index) => (
                  <div className="legend" key={poi.id}>
                    <i style={{ background: colors[index % colors.length] }} />
                    {poi.name} <small>{poi.sourceSheet} row {poi.sourceRow}</small>
                  </div>
                )),
            )}
            <p className="source">
              {provenance.totalPois.toLocaleString()} normalized POIs from{' '}
              <a href={provenance.sourceUrl}>the SF spreadsheet</a> · retrieved {provenance.retrieved}
            </p>
          </section>
        </aside>
        <section className="map-wrap" aria-label="San Francisco feasible area map">
          {status !== 'ready' && (
            <div className={`notice ${status}`} role="status">
              {status === 'loading' ? 'Loading map…' : message}
            </div>
          )}
          <div ref={mapNode} className="map" />
          <div className="attribution">POIs: linked SF dataset · Basemap © Google</div>
        </section>
      </div>
      {message && status === 'ready' && (
        <div className="toast" role="status">
          {message}
        </div>
      )}
    </main>
  );
}
