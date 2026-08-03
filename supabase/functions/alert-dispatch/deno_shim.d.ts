// deno_shim.d.ts — minimal ambient types so this function type-checks with
// plain tsc (npx tsc -p tsconfig.typecheck.json) on machines WITHOUT the Deno
// toolchain. Deno itself never reads this file: it is not imported by any
// module, so the deploy bundler ignores it, and `deno check` uses the real
// runtime types instead.
//
// Keep the surface to exactly what this function touches.

declare namespace Deno {
  export function serve(
    handler: (req: Request) => Response | Promise<Response>,
  ): unknown;

  export namespace env {
    function get(key: string): string | undefined;
  }
}
