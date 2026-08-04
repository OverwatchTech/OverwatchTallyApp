import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { NextConfig } from "next";

// MapLibre's tile worker, self-hosted.
//
// maplibre-gl derives its worker URL from `import.meta.url`; Turbopack does
// not rewrite that to the http(s) URL the vendored chunk is served from, so
// maplibre falls back to `new Worker('')` and nothing on the map ever renders
// (the long version is at the top of farms/[farmId]/map/farm-map.tsx). That
// file pins `setWorkerUrl('/maplibre/maplibre-gl-worker.mjs')`.
//
// Pinning a URL means public/maplibre/ has to hold the worker for the
// maplibre-gl version actually installed — a stale copy would talk the wrong
// message protocol to the main thread, which is the one real fragility of
// this approach. So we re-copy it out of node_modules every time the config
// loads (dev, build), making drift across a maplibre-gl upgrade impossible:
// bump the dependency and the next build refreshes these files. They are
// committed as well so a pruned deploy tree still serves them, which means an
// upgrade shows up as a diff rather than as a silently blank map.
//
// maplibre-gl-worker.mjs is a module worker whose first statement imports
// './maplibre-gl-shared.mjs' relative to itself, so the pair must stay
// together under the same directory and keep their filenames.
const MAPLIBRE_WORKER_ASSETS = [
  "maplibre-gl-worker.mjs",
  "maplibre-gl-shared.mjs",
];

function syncMaplibreWorker() {
  try {
    // Next loads this config from the app directory, and it may hand it to us
    // as CJS or ESM — so resolve from cwd rather than from `import.meta`.
    const resolve = createRequire(join(process.cwd(), "next.config.ts")).resolve;
    const dist = join(dirname(resolve("maplibre-gl/package.json")), "dist");
    const dest = join(process.cwd(), "public", "maplibre");
    mkdirSync(dest, { recursive: true });
    for (const asset of MAPLIBRE_WORKER_ASSETS) {
      copyFileSync(join(dist, asset), join(dest, asset));
    }
  } catch (error) {
    // `next start` in a standalone deploy has no node_modules to copy from,
    // and the committed files are already in place there. Never fail a boot
    // over a refresh that was only ever a convenience.
    console.warn("[maplibre] could not refresh public/maplibre:", error);
  }
}

syncMaplibreWorker();

const nextConfig: NextConfig = {
  // workspace packages are source-linked TS with no build step —
  // Next must transpile them (CLAUDE.md layout section)
  transpilePackages: [
    "@overwatch/db",
    "@overwatch/normalize",
    "@overwatch/forecast",
    "@overwatch/ui",
  ],
  experimental: {
    serverActions: {
      // KML import posts the file's text through a server action (default
      // limit is 1 MB; the reference ranch export is ~200 KB, but Google
      // Earth files with imagery folders run bigger). The action itself
      // rejects anything over 6 MB with a human answer.
      bodySizeLimit: "8mb",
    },
  },
};

export default nextConfig;
