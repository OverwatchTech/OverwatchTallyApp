// Vitest (Vite) `?raw` imports: the round-trip test loads the seed fixture
// packages/db/seeds/farm-project.kml as a plain string. This package carries
// no @types/node (see tests/env.ts), so ?raw is how tests read files.
declare module '*.kml?raw' {
  const content: string;
  export default content;
}
