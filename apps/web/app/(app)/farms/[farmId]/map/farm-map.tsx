'use client';

// Farm map canvas. MapLibre GL over USGS National Map imagery (public
// domain, NAIP-derived — the licensing-safe basemap, CLAUDE.md #3).
// Rendering follows the semantic color rule (CLAUDE.md #4): features are
// thin paper outlines with a barely-there fill; water_source/trough carry
// --water; the teal highlight means "this is what you have selected" and
// nothing else. Hay gold does not appear — hay stacks are features on the
// ground, not projections.
//
// The chrome around the canvas is the approved mockup's Site Map view
// (docs/reference/portal-mockup.html): a 250px layer rail on the left, the
// map filling the rest with no page scroll, floating tool buttons top-left,
// the zoom control bottom-right, a HUD carrying the scale bar and the cursor
// position, and the blurred drawer top-right for the selected feature. CSS in
// ./map-chrome.css.
//
// The map instance is created once and data flows through setData, so an
// edit session (91 gate placements on the reference operation) never tears
// the canvas down. While editing, terra-draw renders every feature it
// manages and the static layers show only the leftovers (rare Multi*
// geometry terra-draw cannot edit); MapEditor reports the managed set.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Map as MaplibreMap, Marker, setWorkerUrl } from 'maplibre-gl';
import type {
  ExpressionSpecification,
  FilterSpecification,
  GeoJSONSource,
  GeoJSONSourceSpecification,
  MapMouseEvent,
  PointLike,
  StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Drawer, DrawerFacts, formatMeasure, tokens } from '@overwatch/ui';
import {
  KIND_LABELS,
  boundsOfGeometries,
  toFeatureCollection,
  type FeatureKind,
  type MapBounds,
  type MapFeatureProperties,
  type MapFeatureRow,
} from '@/lib/map/features';
import { MapEditor } from './map-editor';
import { countByKind, factsLine, layerGroups } from './layers';
import './map-chrome.css';

// MapLibre spins its tile workers up from a URL it derives itself:
//
//   const url = config.WORKER_URL || defaultWorkerUrl();
//   function defaultWorkerUrl() {
//     const u = import.meta.url;
//     if (!/^https?:/.test(u)) return '';            // <- Turbopack lands here
//     return new URL('./maplibre-gl-worker.mjs', u).href;
//   }
//
// Turbopack does not rewrite `import.meta.url` inside the vendored
// maplibre-gl chunk to the http(s) URL the chunk is actually served from, so
// that guard fails and maplibre falls through to `new Worker('', {type:
// 'module'})`. An empty specifier resolves against the document, so the
// worker tries to parse this page's HTML as a module, throws, and no tile
// ever gets parsed: the style never finishes loading, the `features` source
// never loads, and queryRenderedFeatures() returns []. This is why the Site
// Map painted an empty canvas in dev AND in the production build — nothing
// 404s, so there was no obvious error to chase.
//
// The fix is to stop letting maplibre guess. WORKER_URL is pinned to a
// self-hosted copy of the worker under /maplibre/. next.config.ts re-copies
// that directory out of node_modules on every dev/build run, so the copy can
// never drift from the installed maplibre-gl. The worker is a module worker
// that imports './maplibre-gl-shared.mjs' relative to itself — both files
// live in public/maplibre/ for that reason, and neither may be renamed.
//
// Must run before the first `new MaplibreMap`, hence module scope: maplibre
// reads WORKER_URL when it creates the pool, and the pool is created on the
// first map. Setting config is inert on the server, so SSR is unaffected.
setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');

const USGS_IMAGERY_TILES =
  'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}';

const INTERACTIVE_LAYERS = ['feature-fill', 'feature-points'];

/** Layers whose filter carries the rail's kind switches. */
const KIND_FILTERED_LAYERS: { id: string; geometry: 'Polygon' | 'LineString' | 'Point' }[] = [
  { id: 'feature-fill', geometry: 'Polygon' },
  { id: 'feature-outline', geometry: 'Polygon' },
  { id: 'feature-outline-active', geometry: 'Polygon' },
  { id: 'feature-lines', geometry: 'LineString' },
  { id: 'feature-points', geometry: 'Point' },
];

// Label density by zoom: pens and hay stacks name the operation and come in
// first; remaining area features next; gates and other point features only
// when zoomed close.
const LABEL_TIERS = { primary: 14, secondary: 15.5, point: 17 } as const;
type LabelTier = keyof typeof LABEL_TIERS;

/** kind → color for lines/fills/points. Water means liquid, nothing else. */
const KIND_COLOR: ExpressionSpecification = [
  'match',
  ['get', 'kind'],
  ['water_source', 'trough'],
  tokens.water,
  tokens.paper,
];

const HIGHLIGHT_STATE: ExpressionSpecification = [
  'case',
  ['boolean', ['feature-state', 'selected'], false],
  1,
  ['boolean', ['feature-state', 'hover'], false],
  0.7,
  0,
];

const EMPTY_COLLECTION = { type: 'FeatureCollection', features: [] } as const;

/** Web-mercator ground resolution, the standard 256px-tile constant. */
const EQUATOR_M_PER_PX = 156543.03392;
const FEET_PER_METER = 3.280839895;
/** Round steps a scale bar is allowed to land on, in feet. */
const SCALE_STEPS_FT = [
  10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2640, 5280, 10560, 26400, 52800,
];

function geometryCenter(geometry: unknown): [number, number] | null {
  const bounds = boundsOfGeometries([geometry]);
  if (!bounds) return null;
  return [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2];
}

function labelTier(kind: MapFeatureProperties['kind'], isPoint: boolean): LabelTier {
  if (isPoint) return 'point';
  if (kind === 'pen' || kind === 'hay_stack') return 'primary';
  return 'secondary';
}

/** Scale-bar step and its width in px for the current camera. */
function scaleBar(zoom: number, lat: number): { label: string; width: number } {
  const mPerPx = (EQUATOR_M_PER_PX * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
  const ftPerPx = mPerPx * FEET_PER_METER;
  const maxFt = ftPerPx * 96;
  const step = SCALE_STEPS_FT.filter((s) => s <= maxFt).pop() ?? 10;
  const label =
    step >= 2640
      ? `${(step / 5280).toLocaleString('en-US', { maximumFractionDigits: 2 })} mi`
      : `${step.toLocaleString('en-US')} ft`;
  return { label, width: Math.max(18, Math.round(step / ftPerPx)) };
}

function coordText(lng: number, lat: number): string {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

export function FarmMap({
  farmId,
  farmName,
  initialRows,
  bounds,
  canEdit,
}: {
  farmId: string;
  farmName: string;
  initialRows: MapFeatureRow[];
  bounds: MapBounds | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const selectRef = useRef<(id: number | null) => void>(() => {});
  const propsByIdRef = useRef<Map<number, MapFeatureProperties>>(new Map());
  const editingRef = useRef(false);

  // HUD nodes are written to directly on every camera/pointer move — React
  // state at pointer rate would re-render the whole screen for a readout.
  const scaleLabelRef = useRef<HTMLSpanElement>(null);
  const scaleBarRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLSpanElement>(null);
  const zoomRef = useRef<HTMLElement>(null);

  const [rows, setRows] = useState(initialRows);
  const [mapObj, setMapObj] = useState<MaplibreMap | null>(null);
  const [editing, setEditing] = useState(false);
  const [managedIds, setManagedIds] = useState<Set<string> | null>(null);
  const [selected, setSelected] = useState<MapFeatureProperties | null>(null);
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<FeatureKind>>(new Set());
  const [labelsOn, setLabelsOn] = useState(true);
  const [imageryOn, setImageryOn] = useState(true);
  const [railOpen, setRailOpen] = useState(false);

  // Server refetch (router.refresh on Done editing) reconciles client state.
  useEffect(() => setRows(initialRows), [initialRows]);

  editingRef.current = editing;

  // While editing, the static layers carry only what terra-draw does not.
  const visibleRows = useMemo(
    () => (editing && managedIds ? rows.filter((row) => !managedIds.has(row.id)) : rows),
    [rows, editing, managedIds],
  );

  const counts = useMemo(() => countByKind(rows), [rows]);
  const groups = useMemo(() => layerGroups(counts), [counts]);
  const facts = useMemo(() => factsLine(counts), [counts]);

  // ── map instance: created once, torn down on unmount ────────────────────
  const initialBoundsRef = useRef(bounds);
  useEffect(() => {
    const container = containerRef.current;
    const initialBounds = initialBoundsRef.current;
    if (!container || !initialBounds) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const style: StyleSpecification = {
      version: 8,
      sources: {
        usgs: {
          type: 'raster',
          tiles: [USGS_IMAGERY_TILES],
          tileSize: 256,
          maxzoom: 16,
          attribution: 'USGS',
        },
        features: {
          type: 'geojson',
          data: EMPTY_COLLECTION as unknown as GeoJSONSourceSpecification['data'],
        },
      },
      layers: [
        {
          id: 'canvas',
          type: 'background',
          paint: { 'background-color': tokens.app000 },
        },
        { id: 'imagery', type: 'raster', source: 'usgs' },
        {
          id: 'feature-fill',
          type: 'fill',
          source: 'features',
          filter: ['==', ['geometry-type'], 'Polygon'],
          paint: {
            'fill-color': KIND_COLOR,
            'fill-opacity': 0.08,
          },
        },
        {
          id: 'feature-outline',
          type: 'line',
          source: 'features',
          filter: ['==', ['geometry-type'], 'Polygon'],
          paint: {
            'line-color': KIND_COLOR,
            'line-opacity': 0.6,
            'line-width': 1,
          },
        },
        {
          id: 'feature-lines',
          type: 'line',
          source: 'features',
          filter: ['==', ['geometry-type'], 'LineString'],
          paint: {
            'line-color': KIND_COLOR,
            'line-opacity': 0.6,
            'line-width': 1.5,
          },
        },
        {
          // selection/hover highlight — teal only (action/live).
          id: 'feature-outline-active',
          type: 'line',
          source: 'features',
          filter: ['==', ['geometry-type'], 'Polygon'],
          paint: {
            'line-color': tokens.teal,
            'line-opacity': HIGHLIGHT_STATE,
            'line-width': 1.75,
          },
        },
        {
          id: 'feature-points',
          type: 'circle',
          source: 'features',
          filter: ['==', ['geometry-type'], 'Point'],
          paint: {
            'circle-color': [
              'case',
              ['boolean', ['feature-state', 'selected'], false],
              tokens.teal,
              ['boolean', ['feature-state', 'hover'], false],
              tokens.teal,
              KIND_COLOR,
            ],
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2.5, 17, 4.5],
            'circle-opacity': 0.9,
            'circle-stroke-color': tokens.app000,
            'circle-stroke-width': 1,
          },
        },
      ],
    };

    const map = new MaplibreMap({
      container,
      style,
      bounds: initialBounds,
      fitBoundsOptions: { padding: 48 },
      maxZoom: 19,
      attributionControl: { compact: true },
      // prefers-reduced-motion: nothing here flyTo's — the camera only moves
      // on user gestures — and raster cross-fade is dropped as well.
      fadeDuration: reduceMotion ? 0 : 300,
    });

    // North-up instrument: no rotation. Zoom lives in the mockup's own
    // control bottom-right, so MapLibre's stock NavigationControl is gone.
    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();

    let hoverId: number | null = null;
    let selectedId: number | null = null;

    const setState = (id: number, state: { hover?: boolean; selected?: boolean }) =>
      map.setFeatureState({ source: 'features', id }, state);

    const select = (id: number | null) => {
      if (selectedId !== null) setState(selectedId, { selected: false });
      selectedId = id;
      if (id !== null) setState(id, { selected: true });
      setSelected(id !== null ? (propsByIdRef.current.get(id) ?? null) : null);
    };
    selectRef.current = select;

    const topFeatureAt = (point: PointLike) => {
      // Mouse events can land before the style has parsed.
      if (!map.getLayer('feature-fill')) return undefined;
      const found = map.queryRenderedFeatures(point, {
        layers: INTERACTIVE_LAYERS,
      });
      return found[0];
    };

    // ── HUD readouts ──────────────────────────────────────────────────────
    const drawHud = () => {
      const { label, width } = scaleBar(map.getZoom(), map.getCenter().lat);
      if (scaleLabelRef.current) scaleLabelRef.current.textContent = label;
      if (scaleBarRef.current) scaleBarRef.current.style.width = `${width}px`;
      if (zoomRef.current) zoomRef.current.textContent = `z${map.getZoom().toFixed(1)}`;
    };
    drawHud();
    map.on('move', drawHud);

    const onMouseMove = (e: MapMouseEvent) => {
      if (cursorRef.current) cursorRef.current.textContent = coordText(e.lngLat.lng, e.lngLat.lat);
      if (editingRef.current) return; // terra-draw owns the pointer
      const feature = topFeatureAt(e.point);
      const id = typeof feature?.id === 'number' ? feature.id : null;
      if (id !== hoverId) {
        if (hoverId !== null) setState(hoverId, { hover: false });
        hoverId = id;
        if (id !== null) setState(id, { hover: true });
      }
      map.getCanvas().style.cursor = id !== null ? 'pointer' : '';
    };

    const onMouseOut = () => {
      if (cursorRef.current) cursorRef.current.textContent = '—';
    };

    const onClick = (e: MapMouseEvent) => {
      if (editingRef.current) return;
      const feature = topFeatureAt(e.point);
      select(typeof feature?.id === 'number' ? feature.id : null);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (editingRef.current) return;
      if (e.key === 'Escape' && selectedId !== null) select(null);
    };

    map.on('mousemove', onMouseMove);
    map.on('mouseout', onMouseOut);
    map.on('click', onClick);
    window.addEventListener('keydown', onKeyDown);

    // Ready once the (inline) style has parsed — sources and layers exist
    // from that point. The full 'load' event also waits on initial tile
    // fetches, which must not gate editing.
    const markReady = () => setMapObj(map);
    if (map.isStyleLoaded()) markReady();
    else map.once('style.load', markReady);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      selectRef.current = () => {};
      setMapObj(null);
      map.remove(); // tears down layers, markers, and map listeners
    };
  }, []);

  // ── data → GL source (no map teardown) ──────────────────────────────────
  useEffect(() => {
    if (!mapObj) return;
    const source = mapObj.getSource<GeoJSONSource>('features');
    if (!source) return;

    const collection = toFeatureCollection(visibleRows);
    propsByIdRef.current = new Map(
      collection.features.map((feature) => [feature.id, feature.properties]),
    );
    // Numeric GL ids are array indexes — they shift with the data, so any
    // hover/selection state is stale the moment the rows change.
    mapObj.removeFeatureState({ source: 'features' });
    selectRef.current(null);
    source.setData(collection as unknown as GeoJSON.GeoJSON);
  }, [mapObj, visibleRows]);

  // ── layer rail switches → GL filters ────────────────────────────────────
  useEffect(() => {
    if (!mapObj) return;
    const hidden = [...hiddenKinds];
    for (const { id, geometry } of KIND_FILTERED_LAYERS) {
      if (!mapObj.getLayer(id)) continue;
      const base: ExpressionSpecification = ['==', ['geometry-type'], geometry];
      const filter: ExpressionSpecification =
        hidden.length === 0
          ? base
          : ['all', base, ['!', ['in', ['get', 'kind'], ['literal', hidden]]]];
      mapObj.setFilter(id, filter as FilterSpecification);
    }
  }, [mapObj, hiddenKinds]);

  useEffect(() => {
    if (!mapObj || !mapObj.getLayer('imagery')) return;
    mapObj.setLayoutProperty('imagery', 'visibility', imageryOn ? 'visible' : 'none');
  }, [mapObj, imageryOn]);

  // ── name labels: DOM markers in the app's real mono face ────────────────
  // The marker set is rebuilt only when the rows change; the rail's switches
  // reach the existing elements through refs so toggling a layer does not
  // recreate 172 DOM nodes.
  const applyLabelsRef = useRef<() => void>(() => {});
  const labelsOnRef = useRef(labelsOn);
  labelsOnRef.current = labelsOn;
  const hiddenKindsRef = useRef(hiddenKinds);
  hiddenKindsRef.current = hiddenKinds;

  useEffect(() => {
    if (!mapObj) return;

    const markers: Marker[] = [];
    const labels: { el: HTMLSpanElement; tier: LabelTier; kind: FeatureKind }[] = [];
    for (const row of rows) {
      const geometry = row.geojson as { type?: string } | null;
      const isPoint = geometry?.type === 'Point';
      const center = geometryCenter(row.geojson);
      if (!center) continue;

      const el = document.createElement('span');
      el.className = 'map-label machine';
      el.textContent = row.name;
      labels.push({ el, tier: labelTier(row.kind, isPoint), kind: row.kind });

      const marker = new Marker({
        element: el,
        anchor: isPoint ? 'top' : 'center',
        offset: isPoint ? [0, 6] : [0, 0],
      })
        .setLngLat(center)
        .addTo(mapObj);
      markers.push(marker);
    }

    // Labels follow both the zoom tier and the rail: a hidden layer must not
    // leave its names floating over empty ground.
    const applyLabelDensity = () => {
      const zoom = mapObj.getZoom();
      const on = labelsOnRef.current;
      const hidden = hiddenKindsRef.current;
      for (const { el, tier, kind } of labels) {
        el.hidden = !on || hidden.has(kind) || zoom < LABEL_TIERS[tier];
      }
    };
    applyLabelsRef.current = applyLabelDensity;
    applyLabelDensity();
    mapObj.on('zoom', applyLabelDensity);

    return () => {
      applyLabelsRef.current = () => {};
      mapObj.off('zoom', applyLabelDensity);
      for (const marker of markers) marker.remove();
    };
  }, [mapObj, rows]);

  useEffect(() => {
    applyLabelsRef.current();
  }, [labelsOn, hiddenKinds]);

  // ── edit session plumbing ───────────────────────────────────────────────
  const upsertRow = useCallback((row: MapFeatureRow) => {
    setRows((prev) => {
      const index = prev.findIndex((r) => r.id === row.id);
      if (index === -1) return [...prev, row];
      const next = prev.slice();
      next[index] = row;
      return next;
    });
  }, []);

  const removeRow = useCallback((id: string) => {
    setRows((prev) => prev.filter((row) => row.id !== id));
  }, []);

  const toggleEditing = () => {
    if (editing) {
      setEditing(false);
      router.refresh(); // reconcile with server truth once, at the end
    } else {
      selectRef.current(null);
      setEditing(true);
    }
  };

  const toggleKind = (kind: FeatureKind) => {
    setHiddenKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const zoomToSelected = () => {
    if (!mapObj || !selected) return;
    const row = rows.find((r) => r.id === selected.id);
    const target = boundsOfGeometries([row?.geojson]);
    if (!target) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    mapObj.fitBounds(target, { padding: 120, maxZoom: 18, animate: !reduceMotion });
  };

  // Only measured numbers go in the kv grid — its values render mono, and
  // mono is reserved for machine-produced values (CLAUDE.md #11). Species and
  // restrictions are human text and ride in the drawer note instead, so the
  // drawer carries exactly what the old inspector did.
  const drawerFacts = selected
    ? [
        selected.area_m2 !== null
          ? { key: 'area', label: 'Area', value: formatMeasure(selected.area_m2, 'm2') }
          : null,
        selected.perimeter_m !== null
          ? {
              key: 'perimeter',
              label: 'Perimeter',
              value: formatMeasure(selected.perimeter_m, 'm'),
            }
          : null,
        selected.capacity_head !== null
          ? {
              key: 'capacity',
              label: 'Capacity',
              value: `${selected.capacity_head.toLocaleString('en-US')} head`,
            }
          : null,
      ].filter((item): item is { key: string; label: string; value: string } => item !== null)
    : [];

  const drawerNote =
    selected && (selected.species || selected.restrictions) ? (
      <>
        {selected.species && (
          <>
            Species: <b>{selected.species}</b>
          </>
        )}
        {selected.species && selected.restrictions && <br />}
        {selected.restrictions && (
          <>
            Restrictions: <b>{selected.restrictions}</b>
          </>
        )}
      </>
    ) : undefined;

  const railBody = (
    <>
      <div className="ow-railhead">
        <b>{farmName}</b>
        <span className="n">
          {rows.length} {rows.length === 1 ? 'feature' : 'features'} mapped
        </span>
      </div>

      {groups.length > 0 && (
        <>
          {groups.map((group) => (
            <div key={group.label}>
              <div className="ow-sec">{group.label}</div>
              {group.switches.map((sw) => {
                const on = !hiddenKinds.has(sw.kind);
                return (
                  <button
                    key={sw.kind}
                    type="button"
                    role="switch"
                    aria-checked={on}
                    disabled={editing}
                    onClick={() => toggleKind(sw.kind)}
                    className={`ow-lay${on ? ' on' : ''}`}
                  >
                    <span className="sw" aria-hidden="true" />
                    <span>{sw.label}</span>
                    <span className="ct">{sw.count}</span>
                  </button>
                );
              })}
            </div>
          ))}

          <div className="ow-sec">Map</div>
          <button
            type="button"
            role="switch"
            aria-checked={labelsOn}
            onClick={() => setLabelsOn((v) => !v)}
            className={`ow-lay${labelsOn ? ' on' : ''}`}
          >
            <span className="sw" aria-hidden="true" />
            <span>Labels</span>
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={imageryOn}
            onClick={() => setImageryOn((v) => !v)}
            className={`ow-lay${imageryOn ? ' on' : ''}`}
          >
            <span className="sw" aria-hidden="true" />
            <span>Aerial photo</span>
          </button>

          {editing && (
            <div className="ow-railnote">
              While you are editing, every feature stays on the map so you can reach it —
              the switches come back when you finish.
            </div>
          )}

          <div className="ow-sec">Facility</div>
          <div className="ow-facts">
            {facts.map((fact, i) => (
              <span key={fact.label}>
                {i > 0 && ' · '}
                <b>{fact.count}</b> {fact.label}
              </span>
            ))}
          </div>
        </>
      )}

      <div className="ow-sec">Go to</div>
      <div className="ow-raillinks">
        <Link href={`/farms/${farmId}`}>Farm overview</Link>
        {canEdit && <Link href={`/farms/${farmId}/import`}>Import a KML file</Link>}
        {canEdit && <Link href={`/farms/${farmId}/boundary`}>Farm boundary</Link>}
      </div>
    </>
  );

  return (
    <div className="ow-mapshell">
      <div className={`ow-mapwrap${railOpen ? ' railopen' : ''}`}>
        <div className={`ow-rail${railOpen ? ' open' : ''}`} id="map-layer-rail">
          {railBody}
        </div>

        <div className="ow-maparea">
          {bounds ? (
            <>
              {/* h-full/w-full as well as inset-0: maplibre's own stylesheet sets
                  `.maplibregl-map { position: relative }`, which can win the
                  cascade over Tailwind's `absolute` and would otherwise collapse
                  an inset-only box to zero height. */}
              <div ref={containerRef} className="absolute inset-0 h-full w-full" />

              <div className="ow-tools">
                <button
                  type="button"
                  className="ow-tbtn ow-railtoggle"
                  aria-expanded={railOpen}
                  aria-controls="map-layer-rail"
                  onClick={() => setRailOpen((v) => !v)}
                >
                  Layers
                </button>
                {canEdit && (
                  <button
                    type="button"
                    onClick={toggleEditing}
                    disabled={!mapObj}
                    aria-pressed={editing}
                    className={`ow-tbtn${editing ? ' on' : ''}`}
                  >
                    {editing ? 'Done editing' : 'Edit map'}
                  </button>
                )}
                {canEdit && !editing && (
                  <Link href={`/farms/${farmId}/import`} className="ow-tbtn">
                    Import KML
                  </Link>
                )}
                {canEdit && !editing && (
                  <Link href={`/farms/${farmId}/boundary`} className="ow-tbtn">
                    Boundary
                  </Link>
                )}
              </div>

              <div className="ow-zoomctl">
                <button type="button" aria-label="Zoom in" onClick={() => mapObj?.zoomIn()}>
                  +
                </button>
                <button type="button" aria-label="Zoom out" onClick={() => mapObj?.zoomOut()}>
                  −
                </button>
                <button
                  type="button"
                  aria-label="Fit the whole farm"
                  title="Fit the whole farm"
                  onClick={() => mapObj?.fitBounds(bounds, { padding: 48 })}
                >
                  ⛶
                </button>
              </div>

              <div className="ow-hudL">
                <div className="sb">
                  <span ref={scaleLabelRef}>—</span>
                  <div className="b" ref={scaleBarRef} style={{ width: 60 }} />
                </div>
              </div>

              <div className="ow-hudR">
                <span ref={cursorRef}>—</span>
                <br />
                <b ref={zoomRef}>—</b> · aerial photo from USGS
              </div>

              {editing && mapObj && (
                <MapEditor
                  map={mapObj}
                  farmId={farmId}
                  rows={rows}
                  onRowSaved={upsertRow}
                  onRowDeleted={removeRow}
                  onManagedChange={setManagedIds}
                />
              )}

              <Drawer
                open={!editing && selected !== null}
                title={selected?.name ?? ''}
                kind={selected ? KIND_LABELS[selected.kind] : undefined}
                tone="sel"
                note={drawerNote}
                actions={
                  <>
                    <button type="button" className="ow-btn" onClick={zoomToSelected}>
                      Zoom to it
                    </button>
                    <button
                      type="button"
                      className="ow-btn"
                      onClick={() => selectRef.current(null)}
                    >
                      Close
                    </button>
                  </>
                }
              >
                {drawerFacts.length > 0 && <DrawerFacts items={drawerFacts} />}
              </Drawer>
            </>
          ) : (
            <div className="ow-mapempty">
              <b>No map yet</b>
              <p>
                Your installer sketches the pens, alleys, gates, and water on this farm during
                setup. The map shows up here as soon as that sketch is saved — nothing for you
                to do.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
