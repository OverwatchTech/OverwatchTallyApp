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
};

export default nextConfig;
