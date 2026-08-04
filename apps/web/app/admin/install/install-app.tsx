'use client';

// The installer app. Mobile-first, offline-first.
//
// WHY THERE IS NO MAP HERE. The brief allows reusing the map read-only or
// falling back to a lat/lon picker. At the far pasture there is no signal, and
// a MapLibre canvas over remote imagery tiles renders as a grey rectangle
// exactly where it is needed most. Placement is therefore: pick the pen, gate,
// or trough this sensor is mounted on — the `mounted_on` foreign key, which is
// what the schema actually models and which caches for offline use — with the
// handset's own GPS (or typed coordinates) available to drop a new gate or
// trough point where none exists yet.
//
// Every capture is written to IndexedDB before any network call. Sync is a
// chore that happens when signal returns, never a precondition for finishing.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { INSTALLABLE_MODELS, ROLE_LABELS, bomItem, type DeviceRole } from '@/lib/admin/bom';
import { CURVES } from '@/lib/admin/install/calibration';
import { clearSynced, enqueue, flush, listQueue, loadContext, saveContext } from '@/lib/admin/install/queue';
import type { DraftInstall, InstallContext, QueuedInstall } from '@/lib/admin/install/types';
import { Card } from '@overwatch/ui';
import { Field, FormNote, buttonClass, inputClass } from '../console-ui';
import { normalizeDevEui } from '@/lib/admin/dev-eui';
import { relativeTime } from '@/lib/admin/time';
import { CaptureDevEui } from './capture-eui';

const POINT_KIND_FOR_ROLE: Partial<Record<DeviceRole, 'gate' | 'trough'>> = {
  gate_contact: 'gate',
  trough_level: 'trough',
};

export function InstallApp({ context: serverContext }: { context: InstallContext }) {
  const [context, setContext] = useState(serverContext);
  const [online, setOnline] = useState(true);
  const [queue, setQueue] = useState<QueuedInstall[]>([]);
  const [note, setNote] = useState<{ status: 'idle' | 'ok' | 'error'; message: string }>({
    status: 'idle',
    message: '',
  });

  // form state
  const [farmId, setFarmId] = useState(serverContext.farms[0]?.id ?? '');
  const [devEui, setDevEui] = useState('');
  const [model, setModel] = useState(INSTALLABLE_MODELS[0]?.code ?? '');
  const [role, setRole] = useState<DeviceRole>(
    (INSTALLABLE_MODELS[0]?.deviceRole ?? 'trough_level') as DeviceRole,
  );
  const [mountedOn, setMountedOn] = useState('');
  const [coords, setCoords] = useState<{ lng: string; lat: string }>({ lng: '', lat: '' });
  const [pointName, setPointName] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [signal, setSignal] = useState({ rssi: '', snr: '', gateway: '', passed: true, note: '' });
  const [curveValues, setCurveValues] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');

  const farm = context.farms.find((candidate) => candidate.id === farmId);
  const spec = CURVES[role];
  const pointKind = POINT_KIND_FOR_ROLE[role] ?? null;

  const refreshQueue = useCallback(async () => {
    try {
      setQueue(await listQueue());
    } catch {
      // Private-mode browsers can refuse IndexedDB entirely; the form still
      // works online, and the banner below says what is lost.
      setNote({ status: 'error', message: 'This browser will not store captures offline.' });
    }
  }, []);

  // Cache the farm/feature list so a cold reload works with no signal.
  useEffect(() => {
    void saveContext(serverContext);
    void loadContext<InstallContext>().then((cached) => {
      if (cached && serverContext.farms.length === 0) setContext(cached);
    });
    void refreshQueue();
  }, [serverContext, refreshQueue]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    const onOnline = () => {
      update();
      void flush().then(refreshQueue);
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', update);
    };
  }, [refreshQueue]);

  const pending = useMemo(() => queue.filter((entry) => entry.state !== 'synced').length, [queue]);

  const pickModel = (code: string) => {
    setModel(code);
    const item = bomItem(code);
    if (item?.deviceRole) {
      setRole(item.deviceRole);
      setCurveValues({});
    }
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      setNote({ status: 'error', message: 'This handset will not give a position.' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        setCoords({
          lng: position.coords.longitude.toFixed(6),
          lat: position.coords.latitude.toFixed(6),
        }),
      () => setNote({ status: 'error', message: 'No position yet. Type it or move to open sky.' }),
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  };

  const save = async () => {
    const eui = normalizeDevEui(devEui);
    if (!eui.ok) {
      setNote({ status: 'error', message: eui.message });
      return;
    }
    if (!farm) {
      setNote({ status: 'error', message: 'Pick a farm.' });
      return;
    }

    const missing = spec.fields
      .filter((fieldSpec) => fieldSpec.required && !(curveValues[fieldSpec.key] ?? '').trim())
      .map((fieldSpec) => fieldSpec.label);
    if (missing.length > 0) {
      setNote({ status: 'error', message: `Still needed: ${missing.join(', ')}.` });
      return;
    }

    const lng = Number(coords.lng);
    const lat = Number(coords.lat);
    const hasPoint =
      !mountedOn && pointKind !== null && Number.isFinite(lng) && Number.isFinite(lat) && coords.lng !== '';

    const draft: DraftInstall = {
      localId: crypto.randomUUID(),
      farmId: farm.id,
      devEui: eui.value,
      model,
      role,
      mountedOn: mountedOn || null,
      newPoint: hasPoint
        ? { lng, lat, kind: pointKind, name: pointName || `${pointKind} ${eui.value.slice(-4)}` }
        : null,
      signal: {
        rssiDbm: signal.rssi === '' ? null : Number(signal.rssi),
        snrDb: signal.snr === '' ? null : Number(signal.snr),
        gatewayLabel: signal.gateway,
        passed: signal.passed,
        note: signal.note,
      },
      calibration: curveValues,
      notes,
      capturedAt: new Date().toISOString(),
    };

    try {
      await enqueue(draft, photo);
    } catch {
      setNote({
        status: 'error',
        message: 'That capture could not be stored on this handset. Do not walk away yet.',
      });
      return;
    }

    setDevEui('');
    setPhoto(null);
    setCurveValues({});
    setNotes('');
    setSignal({ rssi: '', snr: '', gateway: signal.gateway, passed: true, note: '' });
    setNote({ status: 'ok', message: `${eui.value} saved on this handset.` });
    await refreshQueue();
    if (navigator.onLine) {
      await flush();
      await refreshQueue();
    }
  };

  return (
    <div className="ow-touch ow-pad ow-stack">
      <header>
        <h1 className="ow-pagetitle">Install</h1>
        <p className="ow-pagesub">
          Works with no signal. Captures are held on this handset and go up when the bars come back.
        </p>
      </header>

      <div
        className={online ? 'ow-inline' : 'ow-banner'}
        style={
          online
            ? {
                justifyContent: 'space-between',
                border: '1px solid var(--line)',
                borderRadius: '11px',
                padding: '11px 14px',
                color: 'var(--ink2)',
              }
            : { borderRadius: '11px', border: '1px solid rgba(255,92,56,.4)' }
        }
      >
        <span>{online ? 'Online' : 'No signal — still working'}</span>
        <span className="ow-machine" style={{ marginLeft: 'auto' }}>
          {pending} waiting
        </span>
      </div>

      <Card title="What it is">
        <div className="ow-form bare ow-stack">
          <Field label="Farm">
            <select
              value={farmId}
              onChange={(e) => setFarmId(e.target.value)}
              className={inputClass}
            >
              {context.farms.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.orgName} — {option.name}
                </option>
              ))}
            </select>
          </Field>

          <CaptureDevEui value={devEui} onChange={setDevEui} />

          <Field label="Model">
            <select
              value={model}
              onChange={(e) => pickModel(e.target.value)}
              className={`${inputClass} mono`}
            >
              {INSTALLABLE_MODELS.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.code} — {item.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Role" hint={bomItem(model)?.note}>
            <select
              value={role}
              onChange={(e) => {
                setRole(e.target.value as DeviceRole);
                setCurveValues({});
              }}
              className={inputClass}
            >
              {(Object.keys(ROLE_LABELS) as DeviceRole[]).map((value) => (
                <option key={value} value={value}>
                  {ROLE_LABELS[value]}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Card>

      <Card title="Where it is">
        <div className="ow-form bare ow-stack">
          <Field label="Mounted on" hint="The pen, gate, or trough this sensor watches.">
            <select
              value={mountedOn}
              onChange={(e) => setMountedOn(e.target.value)}
              className={inputClass}
            >
              <option value="">— not on the map yet —</option>
              {(farm?.features ?? []).map((feature) => (
                <option key={feature.id} value={feature.id}>
                  {feature.name} ({feature.kind})
                </option>
              ))}
            </select>
          </Field>

          {!mountedOn && pointKind && (
            <div className="ow-group">
              <p className="ow-quiet">
                Drop a new {pointKind} here. The map screen can move it later.
              </p>
              <div className="ow-fgrid">
                <Field label="Longitude">
                  <input
                    value={coords.lng}
                    inputMode="decimal"
                    onChange={(e) => setCoords({ ...coords, lng: e.target.value })}
                    className={`${inputClass} mono`}
                  />
                </Field>
                <Field label="Latitude">
                  <input
                    value={coords.lat}
                    inputMode="decimal"
                    onChange={(e) => setCoords({ ...coords, lat: e.target.value })}
                    className={`${inputClass} mono`}
                  />
                </Field>
              </div>
              <Field label={`${pointKind} name`}>
                <input
                  value={pointName}
                  onChange={(e) => setPointName(e.target.value)}
                  className={inputClass}
                />
              </Field>
              <button type="button" onClick={useMyLocation} className={buttonClass()}>
                Use my location
              </button>
            </div>
          )}

          {!mountedOn && !pointKind && (
            <p className="ow-quiet">
              Only gates and troughs can be dropped as a new point. Anything else is placed on the
              map screen first, then chosen here.
            </p>
          )}
        </div>
      </Card>

      <Card
        title="Signal check"
        note="Read off ToolBox at the mount point. A browser cannot see LoRa signal, so this is your number and it is recorded as yours."
      >
        <div className="ow-form bare ow-stack">
          <div className="ow-fgrid">
            <Field label="RSSI" hint="dBm">
              <input
                value={signal.rssi}
                inputMode="numeric"
                onChange={(e) => setSignal({ ...signal, rssi: e.target.value })}
                className={`${inputClass} mono`}
              />
            </Field>
            <Field label="SNR" hint="dB">
              <input
                value={signal.snr}
                inputMode="numeric"
                onChange={(e) => setSignal({ ...signal, snr: e.target.value })}
                className={`${inputClass} mono`}
              />
            </Field>
          </div>
          <Field label="Gateway">
            <input
              value={signal.gateway}
              onChange={(e) => setSignal({ ...signal, gateway: e.target.value })}
              className={inputClass}
            />
          </Field>
          <label className="ow-check">
            <input
              type="checkbox"
              checked={signal.passed}
              onChange={(e) => setSignal({ ...signal, passed: e.target.checked })}
            />
            Link is good enough to leave it here
          </label>
          {!signal.passed && (
            <Field label="What is wrong">
              <input
                value={signal.note}
                onChange={(e) => setSignal({ ...signal, note: e.target.value })}
                className={inputClass}
              />
            </Field>
          )}
        </div>
      </Card>

      {spec.fields.length > 0 && (
        <Card title="Calibration" note={spec.summary}>
          <div className="ow-form bare ow-stack">
            {spec.fields.map((fieldSpec) => (
              <Field
                key={fieldSpec.key}
                label={`${fieldSpec.label}${fieldSpec.unit ? ` (${fieldSpec.unit})` : ''}`}
                hint={fieldSpec.hint}
              >
                {fieldSpec.kind === 'select' ? (
                  <select
                    value={curveValues[fieldSpec.key] ?? ''}
                    onChange={(e) =>
                      setCurveValues({ ...curveValues, [fieldSpec.key]: e.target.value })
                    }
                    className={inputClass}
                  >
                    <option value="">—</option>
                    {(fieldSpec.options ?? []).map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={curveValues[fieldSpec.key] ?? ''}
                    inputMode={fieldSpec.kind === 'number' ? 'decimal' : 'text'}
                    onChange={(e) =>
                      setCurveValues({ ...curveValues, [fieldSpec.key]: e.target.value })
                    }
                    className={`${inputClass} mono`}
                  />
                )}
              </Field>
            ))}
          </div>
        </Card>
      )}

      <Card title="Photo and notes">
        <div className="ow-form bare ow-stack">
          <Field label="Install photo" hint="Held on the handset until it uploads.">
            <input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
              className="ow-input"
            />
          </Field>
          <Field label="Notes">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className={inputClass}
            />
          </Field>
        </div>
      </Card>

      <div className="ow-stickyact">
        <button type="button" onClick={() => void save()} className="ow-btn pri block">
          Save install
        </button>
        <FormNote status={note.status} message={note.message} />
      </div>

      <Card
        title="On this handset"
        aside={
          <span className="ow-inline">
            <button
              type="button"
              onClick={() => void flush().then(refreshQueue)}
              className={buttonClass()}
            >
              Sync now
            </button>
            <button
              type="button"
              onClick={() => void clearSynced().then(refreshQueue)}
              className={buttonClass()}
            >
              Clear done
            </button>
          </span>
        }
        padded={false}
      >
        {queue.length === 0 ? (
          <div className="ow-note">Nothing captured yet.</div>
        ) : (
          <ul>
            {queue.map((entry) => (
              <li key={entry.draft.localId} className="ow-listitem">
                <div className="ow-inline" style={{ justifyContent: 'space-between' }}>
                  <span className="ow-machine">{entry.draft.devEui}</span>
                  <span
                    className={`ow-machine ${
                      entry.state === 'synced'
                        ? 'ow-live'
                        : entry.state === 'failed'
                          ? 'ow-wrong'
                          : 'ow-quiet'
                    }`}
                  >
                    {entry.state} · {relativeTime(entry.draft.capturedAt)}
                  </span>
                </div>
                <p className="ow-quiet">
                  {entry.draft.model} · {ROLE_LABELS[entry.draft.role]}
                  {entry.photoStatus !== 'none' && ` · photo ${entry.photoStatus}`}
                </p>
                {entry.lastError && <p className="ow-quiet ow-wrong">{entry.lastError}</p>}
                {entry.photoError && <p className="ow-quiet ow-wrong">{entry.photoError}</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
