/**
 * Privacy-friendly event tracking. Events go to Plausible when its script is on the page
 * (set VITE_PLAUSIBLE_DOMAIN at build time, see vite.config.ts); otherwise they are logged in dev and dropped.
 */
type Props = Record<string, string | number | boolean>;

declare global {
  interface Window { plausible?: (event: string, options?: { props?: Props }) => void }
}

export function track(event: string, props?: Props): void {
  try {
    if (typeof window.plausible === 'function') window.plausible(event, { props });
    else if (import.meta.env.DEV) console.debug('[track]', event, props ?? '');
  } catch { /* analytics must never break play */ }
}
