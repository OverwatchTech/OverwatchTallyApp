'use client';

// Farm map canvas. MapLibre GL over USGS National Map imagery (public
// domain, NAIP-derived — the licensing-safe basemap, CLAUDE.md #3).
// Rendering follows the semantic color rule (CLAUDE.md #4): features are
// thin paper outlines with a barely-there fill; water_source/trough carry
// --water; the teal highlight means "this is what you have selected" and
// nothing else. Hay gold does not appear — hay stacks are features on the
// ground, not projections.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Map as MaplibreMap, Marker, NavigationControl } from 'maplibre-gl';
import type {
  ExpressionSpecification,
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
  type MapBounds,
  type MapFeatureCollection,
  type MapFeatureProperties,
} from '@/lib/map/features';

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
  collection,
  bounds,
}: {
  collection: MapFeatureCollection;
  bounds: MapBounds;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const selectRef = useRef<(id: number | null) => void>(() => {});
  const [selected, setSelected] = useState<MapFeatureProperties | null>(null);

  // Numeric GL feature id (array index) → inspector properties.
  const propsById = useMemo(
    () => new Map(collection.features.map((feature) => [feature.id, feature.properties])),
    [collection],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

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
          data: collection as unknown as GeoJSONSourceSpecification['data'],
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
      bounds,
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

    // Feature name labels as DOM markers so they render in the app's real
    // JetBrains Mono (GL symbol layers would need a separate glyph server).
    const labels: { el: HTMLSpanElement; tier: LabelTier }[] = [];
    for (const feature of collection.features) {
      const geometry = feature.geometry as { type?: string } | null;
      const isPoint = geometry?.type === 'Point';
      const center = geometryCenter(feature.geometry);
      if (!center) continue;

      const el = document.createElement('span');
      el.className = 'map-label machine';
      el.textContent = feature.properties.name;
      labels.push({ el, tier: labelTier(feature.properties.kind, isPoint) });

      new Marker({
        element: el,
        anchor: isPoint ? 'top' : 'center',
        offset: isPoint ? [0, 6] : [0, 0],
      })
        .setLngLat(center)
        .addTo(map);
    }

    const applyLabelDensity = () => {
      const zoom = map.getZoom();
      for (const { el, tier } of labels) {
        el.hidden = zoom < LABEL_TIERS[tier];
      }
    };
    applyLabelDensity();
    map.on('zoom', applyLabelDensity);

    let hoverId: number | null = null;
    let selectedId: number | null = null;

    const setState = (id: number, state: { hover?: boolean; selected?: boolean }) =>
      map.setFeatureState({ source: 'features', id }, state);

    const select = (id: number | null) => {
      if (selectedId !== null) setState(selectedId, { selected: false });
      selectedId = id;
      if (id !== null) setState(id, { selected: true });
      setSelected(id !== null ? (propsById.get(id) ?? null) : null);
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
      const feature = topFeatureAt(e.point);
      select(typeof feature?.id === 'number' ? feature.id : null);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedId !== null) select(null);
    };

    map.on('mousemove', onMouseMove);
    map.on('click', onClick);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      selectRef.current = () => {};
      map.remove(); // tears down layers, markers, and map listeners
    };
  }, [collection, bounds, propsById]);

  return (
    <>
      <div ref={containerRef} className="absolute inset-0" />

      {selected && (
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
    </>
  );
}
