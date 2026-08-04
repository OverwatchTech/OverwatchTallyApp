'use client';

// Hand-drawing session over the farm map (terra-draw + MapLibre adapter).
//
// The editor owns a TerraDraw instance for the life of an edit session:
// every feature terra-draw can edit (Point/LineString/Polygon) is loaded
// into its store and reported up as "managed" so the static layers show
// only the leftovers. Draw tools finish into a keyboard-first name prompt
// (autofocus, Enter saves, Esc cancels — the reference operation has 91
// gates, so placement has to be fast: click, Enter, click, Enter).
//
// Color rule (CLAUDE.md #4): saved features keep their paper/water kind
// colors; teal marks the in-progress sketch and the current selection —
// action and live state, nothing decorative. No animations are added
// anywhere, so prefers-reduced-motion needs no special casing.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { Map as MaplibreMap } from 'maplibre-gl';
import {
  TerraDraw,
  TerraDrawLineStringMode,
  TerraDrawPointMode,
  TerraDrawPolygonMode,
  TerraDrawSelectMode,
  ValidateNotSelfIntersecting,
  type GeoJSONStoreFeatures,
} from 'terra-draw';
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter';
import { tokens } from '@overwatch/ui';
import { KIND_LABELS, type FeatureKind, type MapFeatureRow } from '@/lib/map/features';
import {
  kindsForGeometryType,
  parseEditableGeometry,
  roundPosition,
  type EditableGeometry,
  type Position,
} from '@/lib/map/geometry';
import { nearestOnPolylines, polylinesOfGeometry, type Vec2 } from '@/lib/map/snap';
import { createMapFeature, deleteMapFeature, updateMapFeature } from './actions';

/** Screen-space snap distance for gate/trough placement. */
const SNAP_TOLERANCE_PX = 15;
/** terra-draw's default store precision — ≈0.1 mm of latitude. */
const COORDINATE_PRECISION = 9;

type Tool = 'select' | 'area' | 'line' | 'point';

const TOOL_MODE: Record<Tool, string> = {
  select: 'select',
  area: 'polygon',
  line: 'linestring',
  point: 'point',
};

const MODE_TOOL: Record<string, Tool> = {
  polygon: 'area',
  linestring: 'line',
  point: 'point',
};

const TOOL_GEOMETRY: Record<Exclude<Tool, 'select'>, EditableGeometry['type']> = {
  area: 'Polygon',
  line: 'LineString',
  point: 'Point',
};

// Finish actions that mean "a committed geometry change in select mode".
const GEOMETRY_EDIT_ACTIONS = new Set([
  'dragFeature',
  'dragCoordinate',
  'dragCoordinateResize',
  'deleteCoordinate',
  'insertMidpoint',
  'edit',
]);

const PAPER = tokens.paper;
const WATER = tokens.water;
const TEAL = tokens.teal;
const INK = tokens.app000;

interface PendingSketch {
  tdId: string;
  kind: FeatureKind;
  geometry: EditableGeometry;
}

function capitalize(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function roundGeometry(geometry: EditableGeometry): EditableGeometry {
  const round = (p: Position) => roundPosition(p, COORDINATE_PRECISION);
  if (geometry.type === 'Point') return { type: 'Point', coordinates: round(geometry.coordinates) };
  if (geometry.type === 'LineString') {
    return { type: 'LineString', coordinates: geometry.coordinates.map(round) };
  }
  return { type: 'Polygon', coordinates: geometry.coordinates.map((ring) => ring.map(round)) };
}

/**
 * A DB row as a terra-draw store feature, or null when terra-draw cannot
 * edit it (Multi* geometry etc.) — those stay on the static layers.
 * Coordinates are rounded to the store precision; sub-millimeter, and only
 * written back if the feature is actually edited.
 */
function rowToTdFeature(row: MapFeatureRow): GeoJSONStoreFeatures | null {
  const parsed = parseEditableGeometry(row.geojson);
  if (!parsed.ok) return null;
  const geometry = roundGeometry(parsed.geometry);
  const mode =
    geometry.type === 'Polygon'
      ? 'polygon'
      : geometry.type === 'LineString'
        ? 'linestring'
        : 'point';
  return {
    type: 'Feature',
    id: row.id,
    geometry,
    properties: { mode, kind: row.kind },
  } as GeoJSONStoreFeatures;
}

/** kind → color; water means liquid, in-progress sketches are teal action. */
function featureColor(feature: GeoJSONStoreFeatures): `#${string}` {
  const kind = feature.properties?.kind;
  if (kind === 'water_source' || kind === 'trough') return WATER;
  if (typeof kind === 'string') return PAPER;
  return TEAL;
}

const TOOLS: { id: Tool; label: string; title: string; icon: ReactNode }[] = [
  {
    id: 'select',
    label: 'select',
    title: 'Select and adjust features',
    icon: (
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
        <path
          d="M4 2l8.5 8.5-4.2.6-1.8 3.4L4 2z"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    id: 'area',
    label: 'area',
    title: 'Draw a pen, pasture, or other area',
    icon: (
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
        <path
          d="M8 2l6 4.5-2.3 7H4.3L2 6.5 8 2z"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    id: 'line',
    label: 'fence',
    title: 'Draw a fence run or lane',
    icon: (
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
        <path
          d="M2 13l4.5-6 3.5 3L14 3"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="2" cy="13" r="1.25" fill="currentColor" />
        <circle cx="14" cy="3" r="1.25" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: 'point',
    label: 'point',
    title: 'Place a gate or trough',
    icon: (
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
        <circle cx="8" cy="6" r="3.25" stroke="currentColor" strokeWidth="1.25" />
        <path d="M8 9.25V14" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      </svg>
    ),
  },
];

export function MapEditor({
  map,
  farmId,
  rows,
  onRowSaved,
  onRowDeleted,
  onManagedChange,
}: {
  map: MaplibreMap;
  farmId: string;
  rows: MapFeatureRow[];
  onRowSaved: (row: MapFeatureRow) => void;
  onRowDeleted: (id: string) => void;
  onManagedChange: (ids: Set<string> | null) => void;
}) {
  const drawRef = useRef<TerraDraw | null>(null);
  const managedRef = useRef<Set<string>>(new Set());
  const rowsRef = useRef(rows);
  const toolRef = useRef<Tool>('select');
  const pendingRef = useRef<PendingSketch | null>(null);
  const toolKindsRef = useRef<Record<Exclude<Tool, 'select'>, FeatureKind>>({
    area: 'pen',
    line: 'feed_lane',
    point: 'gate',
  });

  const [tool, setToolState] = useState<Tool>('select');
  const [toolKinds, setToolKinds] = useState(toolKindsRef.current);
  const [pending, setPending] = useState<PendingSketch | null>(null);
  const [nameValue, setNameValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [toolbarIndex, setToolbarIndex] = useState(0);
  const toolButtonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  rowsRef.current = rows;
  toolRef.current = tool;
  pendingRef.current = pending;
  toolKindsRef.current = toolKinds;

  const selectedRow = useMemo(
    () => (selectedId ? (rows.find((row) => row.id === selectedId) ?? null) : null),
    [rows, selectedId],
  );

  const clearPendingSketch = () => {
    const draw = drawRef.current;
    const current = pendingRef.current;
    if (draw && current && draw.hasFeature(current.tdId)) {
      draw.removeFeatures([current.tdId]);
    }
    setPending(null);
    setFormError(null);
  };

  const setTool = (next: Tool) => {
    const draw = drawRef.current;
    if (!draw) return;
    clearPendingSketch();
    setNotice(null);
    setToolState(next);
    draw.setMode(TOOL_MODE[next]);
  };
  const setToolRef = useRef(setTool);
  setToolRef.current = setTool;

  // ── terra-draw lifecycle ────────────────────────────────────────────────
  useEffect(() => {
    const adapter = new TerraDrawMapLibreGLAdapter({ map });

    const draw = new TerraDraw({
      adapter,
      modes: [
        new TerraDrawSelectMode({
          flags: {
            polygon: {
              feature: {
                draggable: false,
                selfIntersectable: false,
                coordinates: { midpoints: true, draggable: true, deletable: true },
              },
            },
            linestring: {
              feature: {
                draggable: false,
                coordinates: { midpoints: true, draggable: true, deletable: true },
              },
            },
            point: { feature: { draggable: true } },
          },
          // Keyboard delete stays off — deleting goes through the inspector,
          // with a typed-name confirm for areas.
          keyEvents: { deselect: 'Escape', delete: null, rotate: null, scale: null },
          styles: {
            selectedPolygonColor: TEAL,
            selectedPolygonFillOpacity: 0.1,
            selectedPolygonOutlineColor: TEAL,
            selectedPolygonOutlineWidth: 2,
            selectedLineStringColor: TEAL,
            selectedLineStringWidth: 2.5,
            selectedPointColor: TEAL,
            selectedPointWidth: 6,
            selectedPointOutlineColor: INK,
            selectedPointOutlineWidth: 1,
            selectionPointColor: PAPER,
            selectionPointWidth: 4.5,
            selectionPointOutlineColor: INK,
            selectionPointOutlineWidth: 1,
            midPointColor: PAPER,
            midPointWidth: 3,
            midPointOutlineColor: INK,
            midPointOutlineWidth: 1,
          },
        }),
        new TerraDrawPolygonMode({
          validation: (feature, { updateType }) => {
            if (updateType === 'finish' || updateType === 'commit') {
              return ValidateNotSelfIntersecting(feature);
            }
            return { valid: true };
          },
          styles: {
            fillColor: featureColor,
            fillOpacity: 0.1,
            outlineColor: featureColor,
            outlineWidth: 1.5,
            closingPointColor: TEAL,
            closingPointWidth: 4,
            closingPointOutlineColor: INK,
            closingPointOutlineWidth: 1,
          },
        }),
        new TerraDrawLineStringMode({
          styles: {
            lineStringColor: featureColor,
            lineStringWidth: 2,
            closingPointColor: TEAL,
            closingPointWidth: 4,
            closingPointOutlineColor: INK,
            closingPointOutlineWidth: 1,
          },
        }),
        new TerraDrawPointMode({
          styles: {
            pointColor: featureColor,
            pointWidth: 5,
            pointOutlineColor: INK,
            pointOutlineWidth: 1,
          },
        }),
      ],
    });

    drawRef.current = draw;
    draw.start();
    draw.setMode('select');

    // Load everything terra-draw can edit; report the managed set so the
    // static layers drop those features for the session.
    const features: GeoJSONStoreFeatures[] = [];
    for (const row of rowsRef.current) {
      const feature = rowToTdFeature(row);
      if (feature) features.push(feature);
    }
    const managed = new Set<string>();
    for (const result of draw.addFeatures(features)) {
      if (result.valid && result.id !== undefined) managed.add(String(result.id));
    }
    managedRef.current = managed;
    onManagedChange(new Set(managed));

    /** Project a row's rings/lines to screen px and snap within tolerance. */
    const snapPoint = (position: Position): Position | null => {
      const p = map.project([position[0], position[1]]);
      const polylines: Vec2[][] = [];
      for (const row of rowsRef.current) {
        for (const line of polylinesOfGeometry(row.geojson)) {
          polylines.push(
            line.map((pos) => {
              const pt = map.project([pos[0], pos[1]]);
              return [pt.x, pt.y] as Vec2;
            }),
          );
        }
      }
      const hit = nearestOnPolylines([p.x, p.y], polylines, SNAP_TOLERANCE_PX);
      if (!hit) return null;
      const lngLat = map.unproject([hit.point[0], hit.point[1]]);
      return roundPosition([lngLat.lng, lngLat.lat], COORDINATE_PRECISION);
    };

    const suggestName = (kind: FeatureKind): string => {
      const label = capitalize(KIND_LABELS[kind]);
      let n = rowsRef.current.filter((row) => row.kind === kind).length + 1;
      while (rowsRef.current.some((row) => row.name === `${label} ${n}`)) n += 1;
      return `${label} ${n}`;
    };

    const handleSketch = (tdId: string, mode: string) => {
      const drawTool = MODE_TOOL[mode];
      if (!drawTool || drawTool === 'select') return;

      const snapshot = draw.getSnapshotFeature(tdId);
      if (!snapshot) return;

      const parsed = parseEditableGeometry(snapshot.geometry);
      if (!parsed.ok) {
        draw.removeFeatures([tdId]);
        setNotice(parsed.reason);
        return;
      }

      let geometry = parsed.geometry;
      let finalId = tdId;

      // Gate/trough snap: pull the point onto the nearest fence line or
      // area edge within ~15 px on screen.
      if (geometry.type === 'Point') {
        const snapped = snapPoint(geometry.coordinates);
        if (snapped) {
          geometry = { type: 'Point', coordinates: snapped };
          draw.removeFeatures([tdId]);
          finalId = crypto.randomUUID();
          draw.addFeatures([
            {
              type: 'Feature',
              id: finalId,
              geometry,
              properties: { mode: 'point' },
            } as GeoJSONStoreFeatures,
          ]);
        }
      }

      // A new sketch replaces any unnamed one — one prompt at a time.
      const previous = pendingRef.current;
      if (previous && draw.hasFeature(previous.tdId)) draw.removeFeatures([previous.tdId]);

      const kind = toolKindsRef.current[drawTool];
      setPending({ tdId: finalId, kind, geometry });
      setNameValue(suggestName(kind));
      setFormError(null);
    };

    const saveGeometry = async (tdId: string) => {
      if (!managedRef.current.has(tdId)) return;
      const snapshot = draw.getSnapshotFeature(tdId);
      if (!snapshot) return;

      const revert = () => {
        const row = rowsRef.current.find((r) => r.id === tdId);
        if (!row) return;
        const original = parseEditableGeometry(row.geojson);
        if (!original.ok) return;
        try {
          draw.updateFeatureGeometry(tdId, roundGeometry(original.geometry));
        } catch {
          // the feature may be mid-teardown; nothing to restore onto
        }
      };

      const parsed = parseEditableGeometry(snapshot.geometry);
      if (!parsed.ok) {
        revert();
        setNotice(parsed.reason);
        return;
      }

      const result = await updateMapFeature({ featureId: tdId, geometry: parsed.geometry });
      if (result.status === 'error') {
        revert();
        setNotice(result.message);
        return;
      }
      setNotice(null);
      onRowSaved(result.row);
    };

    const onFinish = (id: string | number, context: { mode: string; action: string }) => {
      if (context.action === 'draw') {
        handleSketch(String(id), context.mode);
        return;
      }
      if (GEOMETRY_EDIT_ACTIONS.has(context.action)) {
        void saveGeometry(String(id));
      }
    };

    const onSelect = (id: string | number) => {
      const key = String(id);
      setSelectedId(managedRef.current.has(key) ? key : null);
      setNotice(null);
    };

    const onDeselect = () => setSelectedId(null);

    draw.on('finish', onFinish);
    draw.on('select', onSelect);
    draw.on('deselect', onDeselect);

    return () => {
      draw.off('finish', onFinish);
      draw.off('select', onSelect);
      draw.off('deselect', onDeselect);
      try {
        draw.stop(); // clears the store and removes the adapter's layers
      } catch {
        // already stopped with the map torn down — nothing to release
      }
      drawRef.current = null;
      managedRef.current = new Set();
      onManagedChange(null);
    };
  }, [map, onManagedChange, onRowSaved]);

  // Esc exits draw mode (a mid-sketch Esc also cancels the sketch, handled
  // by terra-draw itself when the canvas has focus).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (pendingRef.current) {
        // backup path — the prompt input handles Esc itself when focused
        setToolRef.current(toolRef.current);
        return;
      }
      if (toolRef.current !== 'select') setToolRef.current('select');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // ── create flow ─────────────────────────────────────────────────────────
  const savePending = async (event: FormEvent) => {
    event.preventDefault();
    const draw = drawRef.current;
    const sketch = pendingRef.current;
    if (!draw || !sketch || saving) return;

    const name = nameValue.trim();
    if (!name || name.length > 120) {
      setFormError('Give it a name under 120 characters.');
      return;
    }

    setSaving(true);
    const result = await createMapFeature({
      farmId,
      kind: sketch.kind,
      name,
      geometry: sketch.geometry,
    });
    setSaving(false);

    if (result.status === 'error') {
      setFormError(result.message);
      return;
    }

    // Swap the sketch for the saved feature (server-computed row).
    if (draw.hasFeature(sketch.tdId)) draw.removeFeatures([sketch.tdId]);
    const feature = rowToTdFeature(result.row);
    if (feature) {
      const [added] = draw.addFeatures([feature]);
      if (added?.valid) {
        managedRef.current.add(result.row.id);
        onManagedChange(new Set(managedRef.current));
      }
    }
    onRowSaved(result.row);
    setPending(null);
    setFormError(null);
    map.getCanvas().focus(); // straight back to placing the next one
  };

  const cancelPending = () => {
    clearPendingSketch();
    map.getCanvas().focus();
  };

  // ── edit flow (rename / re-kind / delete) ───────────────────────────────
  const saveDetails = async (
    row: MapFeatureRow,
    name: string,
    kind: FeatureKind,
  ): Promise<string | null> => {
    const result = await updateMapFeature({ featureId: row.id, name, kind });
    if (result.status === 'error') return result.message;
    const draw = drawRef.current;
    if (draw && draw.hasFeature(row.id)) {
      draw.updateFeatureProperties(row.id, { kind: result.row.kind });
    }
    onRowSaved(result.row);
    return null;
  };

  const deleteRow = async (row: MapFeatureRow): Promise<string | null> => {
    const result = await deleteMapFeature({ featureId: row.id });
    if (result.status === 'error') return result.message;
    const draw = drawRef.current;
    if (draw && draw.hasFeature(row.id)) {
      try {
        draw.deselectFeature(row.id);
      } catch {
        // not selected — fine
      }
      draw.removeFeatures([row.id]);
    }
    managedRef.current.delete(row.id);
    onManagedChange(new Set(managedRef.current));
    onRowDeleted(row.id);
    setSelectedId(null);
    return null;
  };

  // ── toolbar keyboard nav (roving tabindex) ──────────────────────────────
  const onToolbarKeyDown = (event: ReactKeyboardEvent) => {
    let next: number | null = null;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      next = (toolbarIndex + 1) % TOOLS.length;
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      next = (toolbarIndex - 1 + TOOLS.length) % TOOLS.length;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = TOOLS.length - 1;
    }
    if (next === null) return;
    event.preventDefault();
    setToolbarIndex(next);
    toolButtonRefs.current[next]?.focus();
  };

  const activeKinds = tool !== 'select' ? kindsForGeometryType(TOOL_GEOMETRY[tool]) : null;

  return (
    <>
      {/* instrument-panel toolbar — same blurred --panel as the map chrome,
          sitting directly under the tool row it belongs to */}
      <div className="ow-mappanel ow-drawtools">
        <div
          role="toolbar"
          aria-label="Draw tools"
          aria-orientation="vertical"
          onKeyDown={onToolbarKeyDown}
          className="grp"
        >
          {TOOLS.map(({ id, label, title, icon }, index) => (
            <button
              key={id}
              ref={(el) => {
                toolButtonRefs.current[index] = el;
              }}
              type="button"
              title={title}
              aria-pressed={tool === id}
              tabIndex={index === toolbarIndex ? 0 : -1}
              onClick={() => {
                setToolbarIndex(index);
                setTool(id);
              }}
              onFocus={() => setToolbarIndex(index)}
              className={`ow-drawtool${tool === id ? ' on' : ''}`}
            >
              {icon}
              <span className="lb">{label}</span>
            </button>
          ))}
        </div>

        {activeKinds && tool !== 'select' && (
          <div className="ow-mapfield">
            <label className="block">
              <span className="k">type</span>
              <select
                value={toolKinds[tool]}
                onChange={(event) =>
                  setToolKinds((prev) => ({
                    ...prev,
                    [tool]: event.target.value as FeatureKind,
                  }))
                }
                className="ow-mapselect"
              >
                {activeKinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>

      {/* keyboard-first name prompt for a finished sketch */}
      {pending && (
        <form onSubmit={savePending} className="ow-mappanel ow-nameprompt">
          <div className="bd">
            <label htmlFor="pending-name" className="k" style={{ display: 'block' }}>
              Name this {KIND_LABELS[pending.kind]}
            </label>
            <input
              id="pending-name"
              autoFocus
              value={nameValue}
              onChange={(event) => setNameValue(event.target.value)}
              onFocus={(event) => event.target.select()}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  cancelPending();
                }
              }}
              className="ow-mapinput"
              style={{ marginTop: 5 }}
            />
            {formError && (
              <p className="ow-msg crit" style={{ padding: '6px 0 0' }}>
                {formError}
              </p>
            )}
            <div className="row">
              <button type="submit" disabled={saving} className="ow-btn pri sm">
                Save {KIND_LABELS[pending.kind]}
              </button>
              <span className="hint">enter saves · esc cancels</span>
            </div>
          </div>
        </form>
      )}

      {/* selected-feature inspector */}
      {selectedRow && (
        <FeatureInspector
          key={selectedRow.id}
          row={selectedRow}
          onSaveDetails={saveDetails}
          onDelete={deleteRow}
          onClose={() => {
            const draw = drawRef.current;
            if (draw && draw.hasFeature(selectedRow.id)) {
              try {
                draw.deselectFeature(selectedRow.id);
              } catch {
                // already deselected
              }
            }
            setSelectedId(null);
          }}
        />
      )}

      {notice && (
        <p role="status" className="ow-mapmsg">
          {notice}
        </p>
      )}
    </>
  );
}

/**
 * Rename, change kind, delete. Deleting an area requires typing its name —
 * the button says exactly what happens ("Delete Small Pen 7").
 */
function FeatureInspector({
  row,
  onSaveDetails,
  onDelete,
  onClose,
}: {
  row: MapFeatureRow;
  onSaveDetails: (row: MapFeatureRow, name: string, kind: FeatureKind) => Promise<string | null>;
  onDelete: (row: MapFeatureRow) => Promise<string | null>;
  onClose: () => void;
}) {
  const geometryType = (row.geojson as { type?: string } | null)?.type;
  const editableType =
    geometryType === 'Polygon' || geometryType === 'LineString' || geometryType === 'Point'
      ? (geometryType as EditableGeometry['type'])
      : null;
  const kindOptions = editableType ? kindsForGeometryType(editableType) : [row.kind];
  const needsTypedConfirm = geometryType === 'Polygon';

  const [name, setName] = useState(row.name);
  const [kind, setKind] = useState<FeatureKind>(row.kind);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [busy, setBusy] = useState(false);

  const submitDetails = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 120) {
      setMessage('Give it a name under 120 characters.');
      return;
    }
    setBusy(true);
    const error = await onSaveDetails(row, trimmed, kind);
    setBusy(false);
    setMessage(error ?? 'Saved.');
  };

  const runDelete = async () => {
    if (busy) return;
    setBusy(true);
    const error = await onDelete(row);
    setBusy(false);
    if (error) setMessage(error);
  };

  return (
    <aside
      aria-label={row.name}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
      className="ow-drawer on"
    >
      <div className="ow-dh">
        <span className="st" style={{ color: 'var(--sel)' }} aria-hidden="true" />
        <b>{row.name}</b>
        <span className="type">{KIND_LABELS[row.kind]}</span>
      </div>

      <form onSubmit={submitDetails}>
        <div className="ow-mapfield" style={{ borderTop: 'none' }}>
          <label htmlFor="feature-name" className="k">
            Name
          </label>
          <input
            id="feature-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="ow-mapinput"
          />
        </div>

        <div className="ow-mapfield">
          <label htmlFor="feature-kind" className="k">
            Type
          </label>
          <select
            id="feature-kind"
            value={kind}
            disabled={!editableType}
            onChange={(event) => setKind(event.target.value as FeatureKind)}
            className="ow-mapselect"
          >
            {kindOptions.map((option) => (
              <option key={option} value={option}>
                {KIND_LABELS[option]}
              </option>
            ))}
          </select>
        </div>

        <div className="ow-acts">
          <button type="submit" disabled={busy} className="ow-btn pri">
            Save {KIND_LABELS[kind]}
          </button>
          <button type="button" onClick={onClose} className="ow-btn">
            Close
          </button>
        </div>
      </form>

      {message && (
        <p role="status" className={`ow-msg${message === 'Saved.' ? '' : ' crit'}`}>
          {message}
        </p>
      )}

      <div className="ow-danger">
        {needsTypedConfirm ? (
          confirming ? (
            <div>
              <label htmlFor="confirm-delete" className="warn">
                Type <span className="machine">{row.name}</span> to confirm
              </label>
              <input
                id="confirm-delete"
                autoFocus
                value={confirmName}
                onChange={(event) => setConfirmName(event.target.value)}
                className="ow-mapinput"
              />
              <div className="ow-acts" style={{ border: 'none', padding: '9px 0 0' }}>
                <button
                  type="button"
                  disabled={busy || confirmName.trim() !== row.name}
                  onClick={runDelete}
                  className="ow-btn danger"
                >
                  Delete {row.name}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirming(false);
                    setConfirmName('');
                  }}
                  className="ow-btn"
                >
                  Keep it
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="ow-btn block danger"
            >
              Delete {row.name}
            </button>
          )
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={runDelete}
            className="ow-btn block danger"
          >
            Delete {row.name}
          </button>
        )}
      </div>
    </aside>
  );
}
