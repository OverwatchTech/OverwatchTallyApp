'use client';

// Legal-boundary onboarding flow: find candidate parcels (address or the
// farm's saved location), pick the ones the farm sits on, set the boundary,
// then preload building footprints. All writes go through server actions;
// RLS is the enforcement behind the owner/manager gate.
//
// Presentation is the approved mockup: Card `.hd/.bd/.note`, `.ow-btn`,
// and the parcel picker as dense hairline-ruled rows. The steps, the words
// and the server actions are unchanged.

import Link from 'next/link';
import { useActionState, useMemo, useState } from 'react';
import { Button, Card } from '@overwatch/ui';
import {
  addBuildings,
  findBuildings,
  searchParcels,
  setFarmBoundary,
} from './actions';
import {
  initialAddBuildingsState,
  initialFindBuildingsState,
  initialParcelSearchState,
  initialSetBoundaryState,
} from './state';
import './setup-forms.css';

export function BoundaryFlow({
  farmId,
  centroidAvailable,
  hasBoundary,
}: {
  farmId: string;
  centroidAvailable: boolean;
  hasBoundary: boolean;
}) {
  const [searchState, searchAction, searching] = useActionState(
    searchParcels,
    initialParcelSearchState,
  );
  const [setState, setAction, saving] = useActionState(
    setFarmBoundary,
    initialSetBoundaryState,
  );
  const [findState, findAction, finding] = useActionState(
    findBuildings,
    initialFindBuildingsState,
  );
  const [addState, addAction, adding] = useActionState(
    addBuildings,
    initialAddBuildingsState,
  );

  const [selectedApns, setSelectedApns] = useState<ReadonlySet<string>>(new Set());

  const candidates = searchState.candidates;
  const selected = useMemo(
    () => candidates.filter((c) => selectedApns.has(c.apn)),
    [candidates, selectedApns],
  );

  // How many outer shapes the selection carries — more than one means the
  // stored boundary is a single outline drawn around everything.
  const selectedShapeCount = useMemo(() => {
    let count = 0;
    for (const c of selected) {
      try {
        const geometry = JSON.parse(c.geojson) as { type?: string; coordinates?: unknown[] };
        count +=
          geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)
            ? geometry.coordinates.length
            : 1;
      } catch {
        count += 1;
      }
    }
    return count;
  }, [selected]);

  const toggle = (apn: string) => {
    setSelectedApns((prev) => {
      const next = new Set(prev);
      if (next.has(apn)) next.delete(apn);
      else next.add(apn);
      return next;
    });
  };

  const buildings = findState.buildings;

  return (
    <>
      <Card
        title="Find the legal boundary"
        sub="county records"
        note="Parcel lookup covers Utah today."
      >
        <p className="ow-prose" style={{ marginBottom: 12 }}>
          Look up the recorded parcels the farm sits on, straight from the county records.
        </p>
        <form action={searchAction}>
          <input type="hidden" name="farmId" value={farmId} />
          <label className="ow-field" htmlFor="parcel-address">
            <span className="k">Farm address</span>
            <input
              id="parcel-address"
              name="address"
              type="text"
              placeholder="160 N Main St, Gunnison, UT 84634"
              className="ow-input"
            />
          </label>
          <div className="ow-formrow">
            <Button
              type="submit"
              variant="primary"
              name="mode"
              value="address"
              disabled={searching}
            >
              {searching ? 'Searching…' : 'Search parcels'}
            </Button>
            <span className="sep">or</span>
            <Button
              type="submit"
              name="mode"
              value="point"
              disabled={searching || !centroidAvailable}
            >
              Use farm location
            </Button>
            {!centroidAvailable && (
              <span className="sep">This farm has no saved location yet.</span>
            )}
          </div>
        </form>

        {(searchState.status === 'error' || searchState.status === 'empty') && (
          <p
            className={`ow-formmsg${searchState.status === 'error' ? ' crit' : ''}`}
            style={{ marginTop: 12 }}
          >
            {searchState.message}
          </p>
        )}
      </Card>

      {searchState.status === 'results' && (
        <Card
          title={`${candidates.length} ${candidates.length === 1 ? 'parcel' : 'parcels'} found`}
          sub="pick every parcel the farm sits on"
          padded={false}
        >
          <div>
            {candidates.map((c) => (
              <label className="ow-pick" key={c.apn}>
                <input
                  type="checkbox"
                  checked={selectedApns.has(c.apn)}
                  onChange={() => toggle(c.apn)}
                />
                <span className="id">{c.apn}</span>
                <span className="sz">{c.acresLabel}</span>
              </label>
            ))}
          </div>
          <div className="ow-bd" style={{ borderTop: '1px solid var(--line)' }}>
            {selectedShapeCount > 1 && (
              <p className="ow-prose faint" style={{ marginBottom: 10 }}>
                More than one shape selected: the boundary is stored as one straight-sided outline
                drawn around everything, so ground between parcels ends up inside the line.
              </p>
            )}
            {setState.status === 'error' && (
              <p className="ow-formmsg crit" style={{ marginBottom: 10 }}>
                {setState.message}
              </p>
            )}
            {setState.status === 'saved' && (
              <p className="ow-formmsg ok" style={{ marginBottom: 10 }}>
                {setState.message}
              </p>
            )}
            <form action={setAction}>
              <input type="hidden" name="farmId" value={farmId} />
              <input
                type="hidden"
                name="parcels"
                value={JSON.stringify(selected.map((c) => ({ apn: c.apn, geojson: c.geojson })))}
              />
              <Button type="submit" variant="primary" disabled={saving || selected.length === 0}>
                {saving ? 'Setting…' : 'Set farm boundary'}
              </Button>
            </form>
          </div>
        </Card>
      )}

      {hasBoundary && (
        <Card title="Buildings" sub="open building maps">
          <p className="ow-prose" style={{ marginBottom: 12 }}>
            Pull barns, sheds, and houses from open building maps so they&apos;re on the farm map
            before anyone draws.
          </p>

          {addState.status === 'added' ? (
            <div>
              <p className="ow-formmsg ok">
                {addState.imported === 0
                  ? 'Nothing new to add.'
                  : `${addState.imported} ${addState.imported === 1 ? 'building' : 'buildings'} added to the map.`}
              </p>
              {addState.skipped > 0 && (
                <p className="ow-prose faint" style={{ marginTop: 6 }}>
                  {addState.skipped} already on the map, skipped.
                </p>
              )}
              <div className="ow-formrow" style={{ marginTop: 12 }}>
                <Link href={`/farms/${farmId}/map`} className="ow-btn">
                  Open map
                </Link>
              </div>
            </div>
          ) : findState.status === 'found' ? (
            <div>
              {buildings.length === 0 ? (
                <p className="ow-prose">
                  No mapped buildings inside the boundary. Open building maps are thin in open
                  country — barns and sheds can be drawn on the farm map instead.
                </p>
              ) : (
                <>
                  <p className="ow-prose">
                    <b>
                      {buildings.length} {buildings.length === 1 ? 'building' : 'buildings'}
                    </b>{' '}
                    found inside the boundary. They come in named Building 1, Building 2, and so
                    on — rename them on the map.
                  </p>
                  {addState.status === 'error' && (
                    <p className="ow-formmsg crit" style={{ marginTop: 10 }}>
                      {addState.message}
                    </p>
                  )}
                  <form action={addAction} style={{ marginTop: 12 }}>
                    <input type="hidden" name="farmId" value={farmId} />
                    <input type="hidden" name="buildings" value={JSON.stringify(buildings)} />
                    <Button type="submit" variant="primary" disabled={adding}>
                      {adding
                        ? 'Adding…'
                        : `Add ${buildings.length} ${buildings.length === 1 ? 'building' : 'buildings'}`}
                    </Button>
                  </form>
                  <p className="ow-prose faint" style={{ marginTop: 10 }}>
                    © OpenStreetMap contributors
                  </p>
                </>
              )}
            </div>
          ) : (
            <div>
              {findState.status === 'error' && (
                <p className="ow-formmsg crit" style={{ marginBottom: 10 }}>
                  {findState.message}
                </p>
              )}
              <form action={findAction}>
                <input type="hidden" name="farmId" value={farmId} />
                <Button type="submit" disabled={finding}>
                  {finding ? 'Looking…' : 'Find buildings'}
                </Button>
              </form>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
