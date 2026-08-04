'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { accentOf, cx, type Tone } from './util';

export interface ToastOptions {
  message: ReactNode;
  /** Colour of the leading dot. Defaults to `ok`. */
  tone?: Tone;
  /** Mono trailing detail, normally a timestamp. */
  meta?: ReactNode;
  /** Milliseconds on screen. Defaults to the provider's `duration`. */
  duration?: number;
}

interface ToastRecord extends ToastOptions {
  id: number;
}

export interface ToastProps {
  message: ReactNode;
  tone?: Tone;
  meta?: ReactNode;
  /** Drives the entrance transition. */
  shown?: boolean;
  className?: string;
}

/** A single toast. Exported for static use; most callers want `useToast()`. */
export function Toast({ message, tone = 'ok', meta, shown = true, className }: ToastProps) {
  return (
    <div className={cx('ow-toast', shown && 'in', className)} role="status">
      <span className="td" style={{ color: accentOf(tone, undefined) }} aria-hidden="true" />
      <span>{message}</span>
      {meta ? <span className="tt">{meta}</span> : null}
    </div>
  );
}

function LiveToast({ toast }: { toast: ToastRecord }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    // rAF gives the browser a paint of the pre-transition state so the
    // entrance actually animates — but it never fires in a background tab,
    // and a toast raised while the operator is on another tab still has to
    // be on screen when they come back. The timeout is the floor.
    const frame = requestAnimationFrame(() => setShown(true));
    const fallback = window.setTimeout(() => setShown(true), 60);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(fallback);
    };
  }, []);
  return <Toast message={toast.message} tone={toast.tone} meta={toast.meta} shown={shown} />;
}

type ToastFn = (toast: ToastOptions | string) => void;

const ToastContext = createContext<ToastFn | null>(null);

export interface ToastProviderProps {
  children: ReactNode;
  /** Default time on screen, in ms. */
  duration?: number;
}

/**
 * Mount once, inside the shell. Toasts stack under the bar at
 * `top: 64px`, centred, and do not take pointer events.
 */
export function ToastProvider({ children, duration = 4000 }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(0);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) window.clearTimeout(timer);
    };
  }, []);

  const push = useCallback<ToastFn>(
    (input) => {
      const options: ToastOptions = typeof input === 'string' ? { message: input } : input;
      const id = nextId.current++;
      setToasts((current) => [...current, { ...options, id }]);
      const timer = window.setTimeout(
        () => setToasts((current) => current.filter((t) => t.id !== id)),
        options.duration ?? duration,
      );
      timers.current.push(timer);
    },
    [duration],
  );

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="ow-toasts">
        {toasts.map((toast) => (
          <LiveToast key={toast.id} toast={toast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Raise a toast. Throws if no `ToastProvider` is mounted above. */
export function useToast(): ToastFn {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside a ToastProvider');
  return context;
}
