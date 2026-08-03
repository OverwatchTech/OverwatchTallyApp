import type { NextConfig } from "next";

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
