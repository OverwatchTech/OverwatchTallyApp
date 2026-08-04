'use client';

import type { ReactNode } from 'react';
import { accentOf, cx, type Tone } from './util';

export interface DrawerProps {
  open: boolean;
  /** Entity name, e.g. a trough or gate code. */
  title: ReactNode;
  /** Mono kind label pushed right in the header. Rancher vocabulary only. */
  kind?: ReactNode;
  /** Colour of the header status dot. */
  tone?: Tone;
  color?: string;
  children?: ReactNode;
  /** Footnote above the actions. */
  note?: ReactNode;
  /** Buttons, laid out in an even row. */
  actions?: ReactNode;
  className?: string;
}

/**
 * Blurred `--panel` overlay, `cubic-bezier(.2,.9,.3,1)` entrance from
 * `translateY(-8px) scale(.98)`. Positioned absolute to its nearest
 * positioned ancestor — give the map area `position: relative`.
 */
export function Drawer({
  open,
  title,
  kind,
  tone = 'ok',
  color,
  children,
  note,
  actions,
  className,
}: DrawerProps) {
  return (
    <aside
      className={cx('ow-drawer', open && 'on', className)}
      aria-hidden={open ? undefined : 'true'}
    >
      <div className="ow-dh">
        <span className="st" style={{ color: accentOf(tone, color) }} aria-hidden="true" />
        <b>{title}</b>
        {kind ? <span className="type">{kind}</span> : null}
      </div>
      {children}
      {note ? <div className="ow-dnote">{note}</div> : null}
      {actions ? <div className="ow-acts">{actions}</div> : null}
    </aside>
  );
}

export interface DrawerFactsProps {
  items: Array<{ key: string; label: ReactNode; value: ReactNode }>;
}

/** Two-column key/value grid for a drawer body. Values render mono. */
export function DrawerFacts({ items }: DrawerFactsProps) {
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
