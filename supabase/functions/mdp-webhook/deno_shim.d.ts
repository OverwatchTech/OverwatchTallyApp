// deno_shim.d.ts — minimal ambient types so this function type-checks with
// plain tsc (npx tsc -p tsconfig.typecheck.json) on machines WITHOUT the Deno
// toolchain. Deno itself never reads this file: it is not imported by any
// module, so the deploy bundler ignores it, and `deno check` uses the real
// runtime types instead (this shim is excluded from any Deno config).
//
// Keep the surface to exactly what index.ts touches.

declare namespace Deno {
  export function serve(
    handler: (req: Request) => Response | Promise<Response>,
  ): unknown;

  export namespace env {
    function get(key: string): string | undefined;
  }
}

// Supabase Edge Runtime global — carries background work past the response.
// Typed as possibly undefined because local `deno run` does not provide it;
// index.ts guards with `typeof EdgeRuntime !== 'undefined'`.
declare const EdgeRuntime:
  | { waitUntil(promise: Promise<unknown>): void }
  | undefined;
