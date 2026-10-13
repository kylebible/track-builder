import type { Layout } from '../layout/layout';
import { layoutFromJson, layoutToJson } from './file';

// The browser autosave: the current layout, kept in localStorage after every
// change. Storage can be missing or full (private windows, blocked site
// data), so every access is allowed to fail quietly.

const KEY = 'track-builder:layout';

export function loadAutosave(): Layout | null {
  try {
    const text = localStorage.getItem(KEY);
    return text ? layoutFromJson(text) : null;
  } catch {
    return null;
  }
}

/** Save the layout; false if the browser wouldn't keep it. */
export function autosave(layout: Layout): boolean {
  try {
    localStorage.setItem(KEY, layoutToJson(layout));
    return true;
  } catch {
    return false;
  }
}
