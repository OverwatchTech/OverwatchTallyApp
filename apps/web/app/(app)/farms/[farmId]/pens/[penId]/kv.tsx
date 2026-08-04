// The mockup's `.kv` two-column key/value grid, as a server component.
//
// @overwatch/ui ships this shape only as `DrawerFacts`, which lives in the
// 'use client' drawer module. The pen vitals block is static server-rendered
// content and has no business dragging a client boundary in for a grid, so
// this renders the same `.ow-kv` classes directly. The CSS is the
// foundation's (apps/web/app/globals.css, `.ow-kv`) — nothing is re-derived
// here.
//
// Worth promoting: a server-safe `Facts` primitive in packages/ui alongside
// DrawerFacts would let every detail screen drop this file.

import type { ReactNode } from 'react';

export interface KvItem {
  key: string;
  label: ReactNode;
  value: ReactNode;
}

export function KvGrid({ items }: { items: KvItem[] }) {
  return (
    <div className="ow-kv">
      {items.map((item) => (
        <div key={item.key}>
          <div className="k">{item.label}</div>
          <div className="v">{item.value}</div>
        </div>
      ))}
    </div>
  );
}
