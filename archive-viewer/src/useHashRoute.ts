import { useSyncExternalStore } from 'react';

function subscribe(callback: () => void): () => void {
  window.addEventListener('hashchange', callback);
  return () => window.removeEventListener('hashchange', callback);
}

function getSnapshot(): string {
  return window.location.hash || '#/';
}

function getServerSnapshot(): string {
  return '#/';
}

/**
 * Returns the current hash (e.g. `#/photo/abc123`). Subscribes via
 * useSyncExternalStore so any component that calls this re-renders on
 * navigation without router-library overhead.
 */
export function useHashRoute(): string {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function navigate(hash: string): void {
  if (!hash.startsWith('#')) hash = '#' + hash;
  window.location.hash = hash;
}

export type Route =
  | { name: 'gallery' }
  | { name: 'photo'; photoId: string }
  | { name: 'collections' }
  | { name: 'collection'; collectionId: string };

/**
 * Parse the hash into a route + params. Tiny matcher rather than pulling in
 * a router library for our handful of routes.
 */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '');
  const photoMatch = path.match(/^\/photo\/([a-zA-Z0-9_-]+)$/);
  if (photoMatch) return { name: 'photo', photoId: photoMatch[1] };
  const collectionMatch = path.match(/^\/collection\/([a-zA-Z0-9_-]+)$/);
  if (collectionMatch) return { name: 'collection', collectionId: collectionMatch[1] };
  if (path === '/collections') return { name: 'collections' };
  return { name: 'gallery' };
}
