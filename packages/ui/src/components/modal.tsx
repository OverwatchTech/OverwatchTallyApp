'use client';

import { useEffect, useId, type ReactNode } from 'react';
import { cx } from './util';

export interface ModalProps {
  open: boolean;
  title?: ReactNode;
  children: ReactNode;
  /** Buttons, right-aligned under the body. */
  actions?: ReactNode;
  /** Called on Escape and on backdrop click. Omit to make the modal modal. */
  onClose?: () => void;
  className?: string;
}

/** `--panel-solid` box on a blurred scrim, mockup entrance curve. */
export function Modal({ open, title, children, actions, onClose, className }: ModalProps) {
  const titleId = useId();

  useEffect(() => {
    if (!open || !onClose) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="ow-modal"
      onClick={onClose ? (event) => {
        if (event.target === event.currentTarget) onClose();
      } : undefined}
    >
      <div
        className={cx('ow-modalbox', className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
      >
        {title ? <h3 id={titleId}>{title}</h3> : null}
        {children}
        {actions ? <div className="ow-modalrow">{actions}</div> : null}
      </div>
    </div>
  );
}
