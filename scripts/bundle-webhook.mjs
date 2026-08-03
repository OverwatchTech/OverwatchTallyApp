// Bundle the mdp-webhook edge function (and its packages/normalize import
// graph) into one deployable ESM file. Deno edge runtime accepts plain ESM;
// everything in the graph is dependency-free TS, so esbuild needs no externals.
//
//   pnpm bundle:webhook   →  supabase/functions/mdp-webhook/dist/index.js

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const result = await build({
  entryPoints: [`${root}supabase/functions/mdp-webhook/index.ts`],
  bundle: true,
  format: 'esm',
  target: 'esnext',
  platform: 'neutral',
  minify: true,
  lineLimit: 400,
  legalComments: 'none',
  outfile: `${root}supabase/functions/mdp-webhook/dist/index.js`,
  logLevel: 'info',
});

if (result.errors.length > 0) process.exit(1);
