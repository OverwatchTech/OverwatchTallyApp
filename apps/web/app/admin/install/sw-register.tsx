'use client';

// Registers the installer service worker. Failure is silent on purpose: a
// browser that refuses service workers still runs the app and still queues to
// IndexedDB — it just will not survive a cold reload with no signal.
import { useEffect } from 'react';

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    void navigator.serviceWorker
      .register('/admin/install/sw.js', { scope: '/admin/install/' })
      .catch(() => {});
  }, []);

  return null;
}
