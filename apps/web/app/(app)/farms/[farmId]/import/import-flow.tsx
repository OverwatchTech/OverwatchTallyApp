'use client';

// KML import flow: choose file → review features → import. The review table
// shows names verbatim and lets the kind be corrected in rancher words
// before anything is written. Import posts the original KML text back — the
// server re-parses it and only takes the kind edits from this form.
//
// Presentation is the approved mockup: Card `.hd/.bd/.note`, the review list
// as a DataTable, `.ow-btn` actions. The stages, the words and the server
// actions are unchanged.

import Link from 'next/link';
import { useActionState } from 'react';
import { Button, Card, DataTable, type DataTableColumn } from '@overwatch/ui';
import { importKml, reviewKml } from './actions';
import { GEOMETRY_LABELS, KIND_OPTIONS } from './kinds';
import { initialImportState, type ReviewFeature } from './state';
import '../boundary/setup-forms.css';

export function ImportFlow({ farmId }: { farmId: string }) {
  const [state, formAction, pending] = useActionState(reviewKml, initialImportState);
  const [importState, importAction, importing] = useActionState(importKml, initialImportState);

  if (importState.stage === 'done') {
    const { imported, skipped } = importState;
    return (
      <Card
        title={
          imported === 0
            ? 'Nothing new to add'
            : `${imported} ${imported === 1 ? 'feature' : 'features'} added to the map`
        }
      >
        {skipped.length > 0 && (
          <>
            <p className="ow-prose">
              Already on the map, skipped {skipped.length}{' '}
              {skipped.length === 1 ? 'feature' : 'features'}:
            </p>
            <div className="ow-namelist">
              {skipped.map((name, i) => (
                <div key={`${name}-${i}`}>{name}</div>
              ))}
            </div>
          </>
        )}
        <div className="ow-formrow" style={{ marginTop: 14 }}>
          <Link href={`/farms/${farmId}/map`} className="ow-btn pri">
            Open map
          </Link>
          <Button onClick={() => window.location.reload()}>Import another file</Button>
        </div>
      </Card>
    );
  }

  // The review stage survives a failed import attempt: prefer the freshest
  // review data, and surface the import error next to the button.
  const review = importState.stage === 'review' ? importState : state;

  if (review.stage === 'review') {
    const n = review.features.length;
    const columns: Array<DataTableColumn<ReviewFeature>> = [
      {
        key: 'name',
        header: 'Name',
        cell: (f) => (
          <>
            {f.name}
            {f.notes === 'kind needs review' && (
              <span style={{ marginLeft: 8, color: 'var(--ink3)', fontSize: '11.5px' }}>
                · kind needs review
              </span>
            )}
          </>
        ),
      },
      {
        key: 'kind',
        header: 'Kind',
        cell: (f) => (
          <select
            name="kinds"
            defaultValue={f.kind}
            aria-label={`Kind for ${f.name}`}
            className="ow-select inline"
          >
            {KIND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ),
      },
      {
        key: 'shape',
        header: 'Shape',
        cell: (f) => <span style={{ color: 'var(--ink2)' }}>{GEOMETRY_LABELS[f.geometryType]}</span>,
      },
      {
        key: 'restriction',
        header: 'Restriction',
        cell: (f) => <span style={{ color: 'var(--ink2)' }}>{f.restrictions ?? '—'}</span>,
      },
    ];

    return (
      <form action={importAction}>
        <input type="hidden" name="farmId" value={farmId} />
        <input type="hidden" name="fileName" value={review.fileName} />
        <input type="hidden" name="kml" value={review.kml} />

        <Card
          title={
            <>
              {n} {n === 1 ? 'feature' : 'features'} in{' '}
              <span className="machine">{review.fileName}</span>
            </>
          }
          padded={false}
          note="Names come in exactly as written. Fix a kind here if the guess is wrong — everything stays editable on the map later."
        >
          <DataTable
            caption={`Features found in ${review.fileName}`}
            columns={columns}
            rows={review.features}
            rowKey={(_row, i) => String(i)}
            maxHeight="46vh"
          />
        </Card>

        {importState.stage === 'review' && importState.message && (
          <p className="ow-formmsg crit" style={{ marginBottom: 12 }}>
            {importState.message}
          </p>
        )}

        <Button type="submit" variant="primary" disabled={importing}>
          {importing ? 'Importing…' : `Import ${n} ${n === 1 ? 'feature' : 'features'}`}
        </Button>
      </form>
    );
  }

  const message = review.message || importState.message;

  return (
    <form action={formAction}>
      <Card
        title="Choose a KML file"
        note={
          <>
            The file from Google Earth (&quot;Export as KML&quot;) works as-is. Nothing is added
            until you review the list.
          </>
        }
      >
        <label className="ow-field" htmlFor="kml-file">
          <span className="k">KML file</span>
          <input
            id="kml-file"
            name="file"
            type="file"
            required
            accept=".kml,application/vnd.google-earth.kml+xml"
            className="ow-file"
          />
        </label>
      </Card>

      {message && (
        <p className="ow-formmsg crit" style={{ marginBottom: 12 }}>
          {message}
        </p>
      )}

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? 'Reading…' : 'Review features'}
      </Button>
    </form>
  );
}
