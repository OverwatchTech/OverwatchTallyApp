"use client";

// KML import flow: choose file → review features → import. The review table
// shows names verbatim and lets the kind be corrected in rancher words
// before anything is written. Import posts the original KML text back — the
// server re-parses it and only takes the kind edits from this form.

import Link from "next/link";
import { useActionState } from "react";
import { importKml, reviewKml } from "./actions";
import { GEOMETRY_LABELS, KIND_OPTIONS } from "./kinds";
import { initialImportState } from "./state";

export function ImportFlow({ farmId }: { farmId: string }) {
  const [state, formAction, pending] = useActionState(reviewKml, initialImportState);
  const [importState, importAction, importing] = useActionState(importKml, initialImportState);

  if (importState.stage === "done") {
    const { imported, skipped } = importState;
    return (
      <section className="rounded-lg border border-hairline bg-card p-6">
        <h2 className="mb-1 text-base font-medium">
          {imported === 0
            ? "Nothing new to add"
            : `${imported} ${imported === 1 ? "feature" : "features"} added to the map`}
        </h2>
        {skipped.length > 0 && (
          <div className="mt-3">
            <p className="text-sm text-muted">
              Already on the map, skipped {skipped.length}{" "}
              {skipped.length === 1 ? "feature" : "features"}:
            </p>
            <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
              {skipped.map((name, i) => (
                <li key={`${name}-${i}`} className="machine text-xs text-muted">
                  {name}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="mt-4 flex gap-4 text-sm">
          <Link
            href={`/farms/${farmId}/map`}
            className="text-accent transition-colors hover:text-foreground"
          >
            Open map
          </Link>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="text-muted transition-colors hover:text-accent"
          >
            Import another file
          </button>
        </div>
      </section>
    );
  }

  // The review stage survives a failed import attempt: prefer the freshest
  // review data, and surface the import error next to the button.
  const review = importState.stage === "review" ? importState : state;

  if (review.stage === "review") {
    const n = review.features.length;
    return (
      <form action={importAction} className="space-y-4">
        <input type="hidden" name="farmId" value={farmId} />
        <input type="hidden" name="fileName" value={review.fileName} />
        <input type="hidden" name="kml" value={review.kml} />

        <section className="rounded-lg border border-hairline bg-card">
          <header className="border-b border-hairline px-4 py-3">
            <h2 className="text-base font-medium">
              {n} {n === 1 ? "feature" : "features"} in{" "}
              <span className="machine text-sm">{review.fileName}</span>
            </h2>
            <p className="mt-1 text-xs text-muted">
              Names come in exactly as written. Fix a kind here if the guess is wrong — everything
              stays editable on the map later.
            </p>
          </header>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-hairline text-left text-xs text-muted">
                  <th className="px-4 py-2 font-normal">Name</th>
                  <th className="px-4 py-2 font-normal">Kind</th>
                  <th className="px-4 py-2 font-normal">Shape</th>
                  <th className="px-4 py-2 font-normal">Restriction</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {review.features.map((f, i) => (
                  <tr key={i}>
                    <td className="px-4 py-2 text-foreground">
                      {f.name}
                      {f.notes === "kind needs review" && (
                        <span className="ml-2 text-xs text-muted">· kind needs review</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <select
                        name="kinds"
                        defaultValue={f.kind}
                        aria-label={`Kind for ${f.name}`}
                        className="rounded-md border border-hairline bg-background px-2 py-1 text-sm text-foreground focus:border-accent focus:outline-none"
                      >
                        {KIND_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-2 text-muted">{GEOMETRY_LABELS[f.geometryType]}</td>
                    <td className="px-4 py-2 text-muted">{f.restrictions ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {importState.stage === "review" && importState.message && (
          <p className="text-sm text-alert">{importState.message}</p>
        )}

        <button
          type="submit"
          disabled={importing}
          className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-background transition-colors hover:bg-accent-deep disabled:opacity-60"
        >
          {importing
            ? "Importing…"
            : `Import ${n} ${n === 1 ? "feature" : "features"}`}
        </button>
      </form>
    );
  }

  const message = review.message || importState.message;

  return (
    <form action={formAction} className="space-y-4">
      <section className="rounded-lg border border-hairline bg-card p-6">
        <label htmlFor="kml-file" className="block text-sm text-muted">
          Choose KML file
        </label>
        <input
          id="kml-file"
          name="file"
          type="file"
          required
          accept=".kml,application/vnd.google-earth.kml+xml"
          className="mt-2 block w-full text-sm text-foreground file:mr-3 file:rounded-md file:border file:border-hairline file:bg-background file:px-3 file:py-1.5 file:text-sm file:text-foreground hover:file:border-accent"
        />
        <p className="mt-2 text-xs text-faint">
          The file from Google Earth (&quot;Export as KML&quot;) works as-is. Nothing is added
          until you review the list.
        </p>
      </section>

      {message && <p className="text-sm text-alert">{message}</p>}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-background transition-colors hover:bg-accent-deep disabled:opacity-60"
      >
        {pending ? "Reading…" : "Review features"}
      </button>
    </form>
  );
}
