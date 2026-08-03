'use client';

// Farm map canvas. MapLibre GL over USGS National Map imagery (public
// domain, NAIP-derived — the licensing-safe basemap, CLAUDE.md #3).
// Rendering follows the semantic color rule (CLAUDE.md #4): features are
// thin paper outlines with a barely-there fill; water_source/trough carry
// --water; the teal highlight means "this is what you have selected" and
// nothing else. Hay gold does not appear — hay stacks are features on the
// ground, not projections.
//
// The map instance is created once and data flows through setData, so an
// edit session (91 gate placements on the reference operation) never tears
// the canvas down. While editing, terra-draw renders every feature it
// manages and the static layers show only the leftovers (rare Multi*
// geometry terra-draw cannot edit); MapEditor reports the managed set.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Map as MaplibreMap, Marker, NavigationControl } from 'maplibre-gl';
import type {
  ExpressionSpecification,
  GeoJSONSource,
  GeoJSONSourceSpecification,
  MapMouseEvent,
  PointLike,
  StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { formatMeasure, tokens } from '@overwatch/ui';
import {
  KIND_LABELS,
  boundsOfGeometries,
  toFeatureCollection,
  type MapBounds,
  type MapFeatureProperties,
  type MapFeatureRow,
} from '@/lib/map/features';
import { MapEditor } from './map-editor';

const USGS_IMAGERY_TILES =
  'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}';

const INTERACTIVE_LAYERS = ['feature-fill', 'feature-points'];

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

  const [rows, setRows] = useState(initialRows);
  const [mapObj, setMapObj] = useState<MaplibreMap | null>(null);
  const [editing, setEditing] = useState(false);
  const [managedIds, setManagedIds] = useState<Set<string> | null>(null);
  const [selected, setSelected] = useState<MapFeatureProperties | null>(null);

  // Server refetch (router.refresh on Done editing) reconciles client state.
  useEffect(() => setRows(initialRows), [initialRows]);

  editingRef.current = editing;

  // While editing, the static layers carry only what terra-draw does not.
  const visibleRows = useMemo(
    () => (editing && managedIds ? rows.filter((row) => !managedIds.has(row.id)) : rows),
    [rows, editing, managedIds],
  );

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

    // North-up instrument: no rotation.
    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();
    map.addControl(new NavigationControl({ showCompass: false }), 'top-left');

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

    const onMouseMove = (e: MapMouseEvent) => {
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

  // ── name labels: DOM markers in the app's real JetBrains Mono ───────────
  useEffect(() => {
    if (!mapObj) return;

    const markers: Marker[] = [];
    const labels: { el: HTMLSpanElement; tier: LabelTier }[] = [];
    for (const row of rows) {
      const geometry = row.geojson as { type?: string } | null;
      const isPoint = geometry?.type === 'Point';
      const center = geometryCenter(row.geojson);
      if (!center) continue;

      const el = document.createElement('span');
      el.className = 'map-label machine';
      el.textContent = row.name;
      labels.push({ el, tier: labelTier(row.kind, isPoint) });

      const marker = new Marker({
        element: el,
        anchor: isPoint ? 'top' : 'center',
        offset: isPoint ? [0, 6] : [0, 0],
      })
        .setLngLat(center)
        .addTo(mapObj);
      markers.push(marker);
    }

    const applyLabelDensity = () => {
      const zoom = mapObj.getZoom();
      for (const { el, tier } of labels) {
        el.hidden = zoom < LABEL_TIERS[tier];
      }
    };
    applyLabelDensity();
    mapObj.on('zoom', applyLabelDensity);

    return () => {
      mapObj.off('zoom', applyLabelDensity);
      for (const marker of markers) marker.remove();
    };
  }, [mapObj, rows]);

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

  return (
    <>
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-hairline bg-background px-6 py-3">
        <div className="flex items-baseline gap-3">
          <h1 className="type-display text-base">{farmName}</h1>
          <span className="machine text-xs text-muted">
            {rows.length} {rows.length === 1 ? 'feature' : 'features'}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canEdit && bounds && (
            <button
              type="button"
              onClick={toggleEditing}
              disabled={!mapObj}
              aria-pressed={editing}
              className={`rounded border px-2 py-1 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 ${
                editing
                  ? 'border-accent text-accent'
                  : 'border-hairline text-foreground hover:border-accent hover:text-accent'
              }`}
            >
              {editing ? 'Done editing' : 'Edit map'}
            </button>
          )}
          <Link
            href={`/farms/${farmId}`}
            className="rounded border border-hairline px-2 py-1 text-xs text-foreground transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
          >
            Back to farm
          </Link>
        </div>
      </header>

      {bounds ? (
        <div className="relative min-h-0 flex-1">
          {/* h-full/w-full as well as inset-0: maplibre's own stylesheet sets
              `.maplibregl-map { position: relative }`, which can win the
              cascade over Tailwind's `absolute` and would otherwise collapse
              an inset-only box to zero height. */}
          <div ref={containerRef} className="absolute inset-0 h-full w-full" />

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

          {!editing && selected && (
            <aside
              aria-label={selected.name}
              className="absolute right-4 top-4 z-10 w-64 rounded-lg border border-hairline bg-card/95 p-4"
            >
              <h2 className="text-sm font-medium text-foreground">{selected.name}</h2>
              <p className="mt-0.5 text-xs text-muted">{KIND_LABELS[selected.kind]}</p>

              <dl className="mt-3 space-y-1.5">
                {selected.area_m2 !== null && (
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-xs text-muted">Area</dt>
                    <dd className="machine text-xs text-foreground">
                      {formatMeasure(selected.area_m2, 'm2')}
                    </dd>
                  </div>
                )}
                {selected.perimeter_m !== null && (
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-xs text-muted">Perimeter</dt>
                    <dd className="machine text-xs text-foreground">
                      {formatMeasure(selected.perimeter_m, 'm')}
                    </dd>
                  </div>
                )}
                {selected.capacity_head !== null && (
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-xs text-muted">Capacity</dt>
                    <dd className="machine text-xs text-foreground">
                      {selected.capacity_head.toLocaleString('en-US')} head
                    </dd>
                  </div>
                )}
                {selected.species && (
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-xs text-muted">Species</dt>
                    <dd className="text-xs text-foreground">{selected.species}</dd>
                  </div>
                )}
                {selected.restrictions && (
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-xs text-muted">Restrictions</dt>
                    <dd className="text-xs text-foreground">{selected.restrictions}</dd>
                  </div>
                )}
              </dl>

              <button
                type="button"
                onClick={() => selectRef.current(null)}
                className="mt-4 w-full rounded border border-hairline px-2 py-1 text-xs text-foreground transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
              >
                Close
              </button>
            </aside>
          )}
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-md rounded-lg border border-hairline bg-card p-6">
            <h2 className="mb-1 text-base font-medium">No map yet</h2>
            <p className="text-sm text-muted">
              Your installer sketches the pens, alleys, gates, and water on this farm during setup.
              The map shows up here as soon as that sketch is saved — nothing for you to do.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
