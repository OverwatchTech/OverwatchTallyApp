'use client';

// DevEUI capture: type it, scan it, or tap it.
//
// Manual entry is the primary path and always present — it is the only one
// that works on every handset, in a dust storm, with gloves on. Scanning and
// NFC are progressive enhancement: the buttons render only where the browser
// actually supports the API, because a control that does nothing is worse than
// no control.
//
// Whatever route the value arrives by, it goes through normalizeDevEui() and
// is stored UPPER CASE. The ingest function looks devices up with an exact
// match on the upper-cased value, so a lower-case registration is a device
// that silently never reports.
import { useCallback, useEffect, useRef, useState } from 'react';
import { devEuiFromScan, formatDevEui, normalizeDevEui } from '@/lib/admin/dev-eui';
import { buttonClass, inputClass } from '@/lib/admin/ui';

interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

interface NdefRecordLike {
  recordType: string;
  encoding?: string;
  data?: DataView;
}
interface NdefReadingEvent {
  serialNumber: string;
  message: { records: NdefRecordLike[] };
}
interface NdefReaderLike {
  scan(options?: { signal?: AbortSignal }): Promise<void>;
  onreading: ((event: NdefReadingEvent) => void) | null;
  onreadingerror: (() => void) | null;
}
type NdefReaderCtor = new () => NdefReaderLike;

function barcodeDetector(): BarcodeDetectorCtor | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector ?? null;
}

function ndefReader(): NdefReaderCtor | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { NDEFReader?: NdefReaderCtor }).NDEFReader ?? null;
}

export function CaptureDevEui({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [typed, setTyped] = useState(value);
  const [message, setMessage] = useState('');
  const [scanning, setScanning] = useState(false);
  const [supportsScan, setSupportsScan] = useState(false);
  const [supportsNfc, setSupportsNfc] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    setSupportsScan(barcodeDetector() !== null && typeof navigator !== 'undefined' && !!navigator.mediaDevices);
    setSupportsNfc(ndefReader() !== null);
  }, []);

  const accept = useCallback(
    (raw: string, source: string) => {
      const result = devEuiFromScan(raw);
      if (!result.ok) {
        setMessage(result.message);
        return false;
      }
      setTyped(result.value);
      onChange(result.value);
      setMessage(`Read from ${source}.`);
      return true;
    },
    [onChange],
  );

  const stopScan = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setScanning(false);
  }, []);

  useEffect(() => stopScan, [stopScan]);

  const startScan = useCallback(async () => {
    const Detector = barcodeDetector();
    if (!Detector) return;
    setMessage('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      streamRef.current = stream;
      setScanning(true);

      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play();

      const detector = new Detector({ formats: ['qr_code', 'data_matrix', 'code_128'] });
      const tick = async () => {
        if (!streamRef.current) return;
        try {
          const found = await detector.detect(video);
          const first = found[0];
          if (first && accept(first.rawValue, 'the code')) {
            stopScan();
            return;
          }
        } catch {
          // A frame that will not decode is normal; keep looking.
        }
        rafRef.current = requestAnimationFrame(() => void tick());
      };
      rafRef.current = requestAnimationFrame(() => void tick());
    } catch {
      setMessage('The camera did not open. Type the DevEUI from the label.');
      stopScan();
    }
  }, [accept, stopScan]);

  const startNfc = useCallback(async () => {
    const Reader = ndefReader();
    if (!Reader) return;
    setMessage('Hold the handset against the sensor.');
    try {
      const reader = new Reader();
      await reader.scan();
      reader.onreadingerror = () => setMessage('That tag would not read. Type the DevEUI instead.');
      reader.onreading = (event) => {
        // Text records first, then the tag serial. Most Milesight sensors are
        // configured over NFC with ToolBox and expose no NDEF text record, so
        // the serial is usually all a browser can see — and it is often not
        // the DevEUI. The value still goes through normalizeDevEui().
        for (const record of event.message.records) {
          if (!record.data) continue;
          try {
            const text = new TextDecoder(record.encoding ?? 'utf-8').decode(record.data);
            if (accept(text, 'the tag')) return;
          } catch {
            // Not decodable as text; try the next record.
          }
        }
        if (!accept(event.serialNumber, 'the tag serial')) {
          setMessage('That tag carries no DevEUI. Type it from the label.');
        }
      };
    } catch {
      setMessage('NFC did not start. Type the DevEUI from the label.');
    }
  }, [accept]);

  const normalized = normalizeDevEui(typed);

  return (
    <div className="space-y-2">
      <label className="block space-y-1">
        <span className="block text-xs text-muted">DevEUI</span>
        <input
          value={typed}
          inputMode="text"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          placeholder="24D124707E04ABCD"
          onChange={(event) => {
            setTyped(event.target.value);
            const result = normalizeDevEui(event.target.value);
            onChange(result.ok ? result.value : '');
            setMessage('');
          }}
          className={`${inputClass} machine text-base uppercase`}
        />
      </label>

      <div className="flex flex-wrap gap-2">
        {supportsScan && (
          <button
            type="button"
            onClick={() => (scanning ? stopScan() : void startScan())}
            className={buttonClass()}
          >
            {scanning ? 'Stop camera' : 'Scan code'}
          </button>
        )}
        {supportsNfc && (
          <button type="button" onClick={() => void startNfc()} className={buttonClass()}>
            Tap NFC
          </button>
        )}
      </div>

      {scanning && (
        <video
          ref={videoRef}
          muted
          playsInline
          className="w-full rounded border border-hairline bg-background"
        />
      )}

      {typed !== '' && (
        <p className={`machine text-xs ${normalized.ok ? 'text-accent' : 'text-alert'}`}>
          {normalized.ok ? formatDevEui(normalized.value) : normalized.message}
        </p>
      )}
      {message && <p className="text-xs text-muted">{message}</p>}
    </div>
  );
}
