"use client";

// Legal-boundary onboarding flow: find candidate parcels (address or the
// farm's saved location), pick the ones the farm sits on, set the boundary,
// then preload building footprints. All writes go through server actions;
// RLS is the enforcement behind the owner/manager gate.

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import {
  addBuildings,
  findBuildings,
  searchParcels,
  setFarmBoundary,
} from "./actions";
import {
  initialAddBuildingsState,
  initialFindBuildingsState,
  initialParcelSearchState,
  initialSetBoundaryState,
} from "./state";

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
          geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates)
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
    <div className="space-y-6">
      <section className="rounded-lg border border-hairline bg-card p-6">
        <h2 className="text-base font-medium">Find the legal boundary</h2>
        <p className="mt-1 text-sm text-muted">
          Look up the recorded parcels the farm sits on, straight from the county records.
        </p>
        <form action={searchAction} className="mt-4 space-y-3">
          <input type="hidden" name="farmId" value={farmId} />
          <div className="space-y-1.5">
            <label htmlFor="parcel-address" className="block text-sm text-muted">
              Farm address
            </label>
            <input
              id="parcel-address"
              name="address"
              type="text"
              placeholder="160 N Main St, Gunnison, UT 84634"
              className="w-full rounded-md border border-hairline bg-background px-3 py-2 text-sm text-foreground placeholder:text-faint focus:border-accent focus:outline-none"
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              name="mode"
              value="address"
              disabled={searching}
              className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-background transition-colors hover:bg-accent-deep disabled:opacity-60"
            >
              {searching ? "Searching…" : "Search parcels"}
            </button>
            <span className="text-xs text-faint">or</span>
            <button
              type="submit"
              name="mode"
              value="point"
              disabled={searching || !centroidAvailable}
              className="rounded-md border border-hairline px-3 py-2 text-sm text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-60"
            >
              Use farm location
            </button>
            {!centroidAvailable && (
              <span className="text-xs text-faint">This farm has no saved location yet.</span>
            )}
          </div>
          <p className="text-xs text-faint">Parcel lookup covers Utah today.</p>
        </form>

        {(searchState.status === "error" || searchState.status === "empty") && (
          <p
            className={`mt-3 text-sm ${searchState.status === "error" ? "text-alert" : "text-muted"}`}
          >
            {searchState.message}
          </p>
        )}
      </section>

      {searchState.status === "results" && (
        <section className="rounded-lg border border-hairline bg-card">
          <header className="border-b border-hairline px-4 py-3">
            <h2 className="text-base font-medium">
              {candidates.length} {candidates.length === 1 ? "parcel" : "parcels"} found
            </h2>
            <p className="mt-1 text-xs text-muted">
              Pick every parcel the farm sits on, then set the boundary.
            </p>
          </header>
          <ul className="divide-y divide-hairline">
            {candidates.map((c) => (
              <li key={c.apn}>
                <label className="flex cursor-pointer items-center gap-3 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={selectedApns.has(c.apn)}
                    onChange={() => toggle(c.apn)}
                    className="h-4 w-4 accent-[--accent]"
                  />
                  <span className="machine text-sm text-foreground">{c.apn}</span>
                  <span className="text-sm text-muted">{c.acresLabel}</span>
                </label>
              </li>
            ))}
          </ul>
          <footer className="space-y-3 border-t border-hairline px-4 py-4">
            {selectedShapeCount > 1 && (
              <p className="text-xs text-muted">
                More than one shape selected: the boundary is stored as one straight-sided outline
                drawn around everything, so ground between parcels ends up inside the line.
              </p>
            )}
            {setState.status === "error" && (
              <p className="text-sm text-alert">{setState.message}</p>
            )}
            {setState.status === "saved" && (
              <p className="text-sm text-accent">{setState.message}</p>
            )}
            <form action={setAction}>
              <input type="hidden" name="farmId" value={farmId} />
              <input
                type="hidden"
                name="parcels"
                value={JSON.stringify(selected.map((c) => ({ apn: c.apn, geojson: c.geojson })))}
              />
              <button
                type="submit"
                disabled={saving || selected.length === 0}
                className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-background transition-colors hover:bg-accent-deep disabled:opacity-60"
              >
                {saving ? "Setting…" : "Set farm boundary"}
              </button>
            </form>
          </footer>
        </section>
      )}

      {hasBoundary && (
        <section className="rounded-lg border border-hairline bg-card p-6">
          <h2 className="text-base font-medium">Buildings</h2>
          <p className="mt-1 text-sm text-muted">
            Pull barns, sheds, and houses from open building maps so they&apos;re on the farm
            map before anyone draws.
          </p>

          {addState.status === "added" ? (
            <div className="mt-4 space-y-2">
              <p className="text-sm text-accent">
                {addState.imported === 0
                  ? "Nothing new to add."
                  : `${addState.imported} ${addState.imported === 1 ? "building" : "buildings"} added to the map.`}
              </p>
              {addState.skipped > 0 && (
                <p className="text-xs text-muted">
                  {addState.skipped} already on the map, skipped.
                </p>
              )}
              <Link
                href={`/farms/${farmId}/map`}
                className="inline-block text-sm text-accent transition-colors hover:text-foreground"
              >
                Open map
              </Link>
            </div>
          ) : findState.status === "found" ? (
            <div className="mt-4 space-y-3">
              {buildings.length === 0 ? (
                <p className="text-sm text-muted">
                  No mapped buildings inside the boundary. Open building maps are thin in open
                  country — barns and sheds can be drawn on the farm map instead.
                </p>
              ) : (
                <>
                  <p className="text-sm text-foreground">
                    {buildings.length} {buildings.length === 1 ? "building" : "buildings"} found
                    inside the boundary. They come in named Building 1, Building 2, and so on —
                    rename them on the map.
                  </p>
                  {addState.status === "error" && (
                    <p className="text-sm text-alert">{addState.message}</p>
                  )}
                  <form action={addAction}>
                    <input type="hidden" name="farmId" value={farmId} />
                    <input
                      type="hidden"
                      name="buildings"
                      value={JSON.stringify(buildings)}
                    />
                    <button
                      type="submit"
                      disabled={adding}
                      className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-background transition-colors hover:bg-accent-deep disabled:opacity-60"
                    >
                      {adding
                        ? "Adding…"
                        : `Add ${buildings.length} ${buildings.length === 1 ? "building" : "buildings"}`}
                    </button>
                  </form>
                  <p className="text-xs text-faint">© OpenStreetMap contributors</p>
                </>
              )}
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              {findState.status === "error" && (
                <p className="text-sm text-alert">{findState.message}</p>
              )}
              <form action={findAction}>
                <input type="hidden" name="farmId" value={farmId} />
                <button
                  type="submit"
                  disabled={finding}
                  className="rounded-md border border-hairline px-3 py-2 text-sm text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-60"
                >
                  {finding ? "Looking…" : "Find buildings"}
                </button>
              </form>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
