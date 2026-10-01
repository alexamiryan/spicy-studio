import { useSyncExternalStore } from 'react';
import { api } from './api';

/**
 * Notices when the server has been updated to a newer web build than the one this tab is running,
 * so the app can offer a refresh. Installed PWAs (iPhone especially) otherwise keep the old version
 * until they are killed.
 */
const running = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.getAttribute('src') || null;
let available = false;
const listeners = new Set<() => void>();
let lastCheck = 0;

export async function checkForUpdate() {
  if (!running || available || Date.now() - lastCheck < 5_000) return;
  lastCheck = Date.now();
  try {
    const { web } = await api.get<{ web: string | null }>('/api/version');
    if (web && web !== running) {
      available = true;
      listeners.forEach(fn => fn());
    }
  } catch { /* offline or signed out: try again later */ }
}

let started = false;
/** Check on return to the app and every 10 minutes (the live-updates connection also checks on reconnect). */
export function startUpdateChecks() {
  if (started || !running) return;
  started = true;
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(); });
  window.addEventListener('focus', () => checkForUpdate());
  setInterval(checkForUpdate, 10 * 60_000);
  checkForUpdate();
}

export function useUpdateAvailable() {
  return useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => available);
}
